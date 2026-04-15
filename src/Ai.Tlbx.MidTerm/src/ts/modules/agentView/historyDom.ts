import { t } from '../i18n';
import { getSession } from '../../stores';
import { renderMarkdownFragment, wireMarkdownTables } from '../../utils/markdown';
import {
  buildAssistantEnrichedHtml,
  createAssistantImagePreviewBlock,
  enrichInteractiveTextContent,
  wireAssistantInteractiveContent,
} from './assistantEnrichment';
import type { LensHistoryRequestSummary } from '../../api/client';
import type { LensAttachmentReference } from '../../api/types';
import {
  buildLensAttachmentUrl,
  isImageAttachment,
  resolveAttachmentLabel,
  resolveHistoryBadgeLabel,
} from './activationHelpers';
import { createRequestActionBlock as createRequestActionBlockInternal } from './historyRequestDom';
import {
  buildRenderedDiffLines,
  hasInlineCommandPresentation,
  resolveHistoryBodyPresentation,
  tokenizeCommandText,
} from './historyContent';
import type {
  AssistantMarkdownCacheEntry,
  ArtifactClusterInfo,
  HistoryBodyPresentation,
  LensHistoryAction,
  LensHistoryEntry,
  LensVirtualizerDebugState,
  LensRuntimeStatsSummary,
  SessionLensViewState,
} from './types';

const BUSY_SWEEP_WALLCLOCK_CYCLE_MS = 3770;
const BUSY_SPIN_WALLCLOCK_CYCLE_MS = 1150;

function lensText(key: string, fallback: string): string {
  const translated = t(key);
  return !translated || translated === key ? fallback : translated;
}

function lensFormat(
  key: string,
  fallback: string,
  replacements: Record<string, string | number>,
): string {
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    lensText(key, fallback),
  );
}

function resolveHistoryBadgeTextForEntry(
  entry: LensHistoryEntry,
  provider: string | null | undefined,
): string {
  if (entry.kind !== 'user' && entry.kind !== 'assistant' && entry.label.trim()) {
    return entry.label.trim();
  }

  return resolveHistoryBadgeLabel(entry.kind, provider);
}

function normalizeHistoryTitle(entry: LensHistoryEntry): string {
  const title = entry.title.trim();
  if (!title || entry.commandText) {
    return '';
  }

  if ((entry.kind === 'user' || entry.kind === 'assistant') && title === entry.label) {
    return '';
  }

  return title;
}

type AgentHistoryDomDeps = {
  getState: (sessionId: string) => SessionLensViewState | undefined;
  refreshLensSnapshot: (sessionId: string) => Promise<void>;
  renderCurrentAgentView: (sessionId: string) => void;
  retryLensActivation: (sessionId: string) => Promise<void>;
  logWarn: (message: () => string) => void;
};

function appendInlineRequestWidgetToArticle(args: {
  article: HTMLElement;
  createRequestActionBlock: (
    sessionId: string,
    request: LensHistoryRequestSummary,
    busy: boolean,
    state: SessionLensViewState,
    surface: 'composer' | 'history',
  ) => HTMLElement;
  deps: AgentHistoryDomDeps;
  entry: LensHistoryEntry;
  sessionId: string;
}): boolean {
  const { article, createRequestActionBlock, deps, entry, sessionId } = args;
  if (entry.kind !== 'request' || !entry.requestId) {
    return false;
  }

  const state = deps.getState(sessionId);
  const request = state?.snapshot?.requests.find(
    (candidate) => candidate.requestId === entry.requestId,
  );
  if (!state || !request) {
    return false;
  }

  article.classList.add('agent-history-request-inline');
  article.appendChild(
    createRequestActionBlock(
      sessionId,
      request,
      state.requestBusyIds.has(request.requestId),
      state,
      'history',
    ),
  );
  return true;
}

function createTurnDurationNoteBody(entry: LensHistoryEntry): HTMLElement {
  const body = document.createElement('div');
  body.className = 'agent-history-body agent-history-turn-duration-body';

  const marker = document.createElement('div');
  marker.className = 'agent-history-turn-duration-marker';

  const topSegment = document.createElement('span');
  topSegment.className = 'agent-history-turn-duration-segment';
  marker.appendChild(topSegment);

  const label = document.createElement('span');
  label.className = 'agent-history-turn-duration-label';
  label.textContent = entry.body;
  marker.appendChild(label);

  const bottomSegment = document.createElement('span');
  bottomSegment.className = 'agent-history-turn-duration-segment';
  marker.appendChild(bottomSegment);

  body.appendChild(marker);
  return body;
}

function createDiffLineGutterNode(
  oldLineNumber: number | undefined,
  newLineNumber: number | undefined,
): HTMLElement {
  const gutter = document.createElement('span');
  gutter.className = 'agent-history-diff-line-gutter';
  gutter.appendChild(createDiffLineNumberNode(oldLineNumber, 'old'));
  gutter.appendChild(createDiffLineNumberNode(newLineNumber, 'new'));
  return gutter;
}

function createDiffLineNumberNode(value: number | undefined, lane: 'old' | 'new'): HTMLElement {
  const cell = document.createElement('span');
  cell.className = `agent-history-diff-line-number agent-history-diff-line-number-${lane}`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    cell.textContent = String(value);
  } else {
    cell.textContent = '';
    cell.setAttribute('aria-hidden', 'true');
  }
  return cell;
}

function getEntryFileMentions(entry: LensHistoryEntry, field: 'title' | 'body' | 'commandText') {
  return (entry.fileMentions ?? []).filter((mention) => mention.field === field);
}

function appendEntryImagePreviews(
  body: HTMLElement,
  entry: LensHistoryEntry,
  sessionId: string,
): void {
  const previewBlock = createAssistantImagePreviewBlock(
    document,
    sessionId,
    entry.imagePreviews ?? [],
  );
  if (previewBlock) {
    body.appendChild(previewBlock);
  }
}

function collapseSingleParagraphMarkdownBody(container: HTMLElement): void {
  if (container.childElementCount !== 1) {
    return;
  }

  const first = container.firstElementChild;
  if (!first || first.tagName !== 'P' || first.attributes.length > 0) {
    return;
  }

  container.innerHTML = first.innerHTML;
}

function ensureVirtualizerDebugState(state: SessionLensViewState): LensVirtualizerDebugState {
  const stateRecord = state as unknown as Record<string, unknown>;
  const existing = stateRecord['historyVirtualizerDebug'];
  if (isLensVirtualizerDebugState(existing)) {
    return existing;
  }

  const created: LensVirtualizerDebugState = {
    host: null,
    placeholderCount: 0,
    visibleRange: {
      absoluteStart: null,
      absoluteEnd: null,
      startId: null,
      endId: null,
    },
    recentFetches: [],
  };
  stateRecord['historyVirtualizerDebug'] = created;
  return created;
}

function isLensVirtualizerDebugState(value: unknown): value is LensVirtualizerDebugState {
  return value !== null && typeof value === 'object';
}

/* eslint-disable max-lines-per-function -- history row rendering remains intentionally consolidated in one DOM factory. */
export function createAgentHistoryDom(deps: AgentHistoryDomDeps) {
  function resolveWallclockNowMs(): number {
    if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
      return Date.now();
    }

    if (typeof performance.timeOrigin === 'number' && Number.isFinite(performance.timeOrigin)) {
      return performance.timeOrigin + performance.now();
    }

    return Date.now() + performance.now();
  }

  function resolveWallclockAnimationDelayMs(cycleMs: number): string {
    const nowMs = resolveWallclockNowMs();
    const phaseMs = ((nowMs % cycleMs) + cycleMs) % cycleMs;
    const delayMs = -phaseMs;
    return `${delayMs.toFixed(3).replace(/\.?0+$/, '')}ms`;
  }

  function applyBusyIndicatorPhaseLock(root: ParentNode): void {
    const selectorRoot = root as unknown as Record<string, unknown>;
    if (typeof selectorRoot['querySelector'] !== 'function') {
      return;
    }

    const label = (root as Element).querySelector<HTMLElement>('.agent-history-busy-label');
    if (label) {
      label.style.setProperty(
        '--agent-busy-animation-delay-ms',
        resolveWallclockAnimationDelayMs(BUSY_SWEEP_WALLCLOCK_CYCLE_MS),
      );
    }

    const spinner = (root as Element).querySelector<HTMLElement>('.agent-history-busy-spinner');
    if (spinner) {
      spinner.style.setProperty(
        '--agent-busy-spin-delay-ms',
        resolveWallclockAnimationDelayMs(BUSY_SPIN_WALLCLOCK_CYCLE_MS),
      );
    }
  }

  function syncBusyIndicatorEntry(article: HTMLElement, entry: LensHistoryEntry): void {
    if (!entry.busyIndicator) {
      return;
    }

    const selectorRoot = article as unknown as Record<string, unknown>;
    if (typeof selectorRoot['querySelector'] !== 'function') {
      return;
    }

    const labelText = entry.body || 'Working';
    const label = article.querySelector<HTMLElement>('.agent-history-busy-label');
    if (label) {
      label.dataset.text = labelText;
      const labelBase = label.querySelector<HTMLElement>('.agent-history-busy-label-base');
      if (labelBase && labelBase.textContent !== labelText) {
        labelBase.textContent = labelText;
      }
      const labelGlow = label.querySelector<HTMLElement>('.agent-history-busy-label-glow');
      if (labelGlow && labelGlow.textContent !== labelText) {
        labelGlow.textContent = labelText;
      }
    }

    const elapsed = article.querySelector<HTMLElement>('.agent-history-busy-elapsed');
    if (elapsed) {
      const elapsedText = entry.busyElapsedText ?? '0s';
      if (elapsed.textContent !== elapsedText) {
        elapsed.textContent = elapsedText;
      }
    }

    applyBusyIndicatorPhaseLock(article);
  }

  function renderRuntimeStats(panel: HTMLDivElement, stats: LensRuntimeStatsSummary | null): void {
    const host = panel.querySelector<HTMLDivElement>('[data-agent-field="runtime-stats"]');
    if (!host) {
      return;
    }

    if (!stats) {
      host.hidden = true;
      host.replaceChildren();
      if (typeof host.removeAttribute === 'function') {
        host.removeAttribute('aria-label');
        host.removeAttribute('title');
      }
      host.title = '';
      return;
    }

    const compact = [
      formatTokenWindowCompact(stats),
      `in ${formatTokenCount(stats.accumulatedInputTokens)}`,
      `out ${formatTokenCount(stats.accumulatedOutputTokens)}`,
    ].join('  ');
    const detailParts = [
      formatTokenWindowDetail(stats),
      `Session in ${formatTokenCount(stats.accumulatedInputTokens)}`,
      `Session out ${formatTokenCount(stats.accumulatedOutputTokens)}`,
    ];
    if (
      stats.primaryRateLimitUsedPercent !== null ||
      stats.secondaryRateLimitUsedPercent !== null
    ) {
      detailParts.push(
        `Rate ${formatPercent(stats.primaryRateLimitUsedPercent)} / ${formatPercent(stats.secondaryRateLimitUsedPercent)}`,
      );
    }

    host.hidden = false;
    host.setAttribute('aria-label', detailParts.join(' | '));
    host.title = detailParts.join('\n');
    host.replaceChildren();

    const compactText = document.createElement('span');
    compactText.className = 'agent-runtime-stats-compact';
    compactText.textContent = compact;
    host.appendChild(compactText);

    const detail = document.createElement('div');
    detail.className = 'agent-runtime-stats-detail';
    for (const part of detailParts) {
      const line = document.createElement('div');
      line.className = 'agent-runtime-stats-detail-line';
      line.textContent = part;
      detail.appendChild(line);
    }

    host.appendChild(detail);
  }

  function formatVirtualizerVisibleRange(
    visibleRange: LensVirtualizerDebugState['visibleRange'],
  ): string {
    if (
      visibleRange.absoluteStart === null ||
      visibleRange.absoluteEnd === null ||
      !visibleRange.startId ||
      !visibleRange.endId
    ) {
      return 'none';
    }

    return `#${visibleRange.absoluteStart + 1}..#${visibleRange.absoluteEnd + 1} (${visibleRange.startId} -> ${visibleRange.endId})`;
  }

  function renderVirtualizerDebug(
    panel: HTMLDivElement,
    state: SessionLensViewState | undefined,
  ): void {
    const host = panel.querySelector<HTMLDivElement>('[data-agent-field="virtualizer-debug"]');
    if (!host || !state?.snapshot) {
      if (host) {
        host.hidden = true;
        host.replaceChildren();
      }
      return;
    }

    const debugState = ensureVirtualizerDebugState(state);
    debugState.host = host;

    host.hidden = false;
    host.replaceChildren();

    const heading = document.createElement('div');
    heading.className = 'agent-virtualizer-debug-heading';
    heading.textContent = 'Virtualizer';
    host.appendChild(heading);

    const lines = [
      `overall ${state.snapshot.historyCount}`,
      `placeholders ${debugState.placeholderCount}`,
      `in view ${formatVirtualizerVisibleRange(debugState.visibleRange)}`,
    ];
    for (const text of lines) {
      const line = document.createElement('div');
      line.className = 'agent-virtualizer-debug-line';
      line.textContent = text;
      host.appendChild(line);
    }

    const fetchHeading = document.createElement('div');
    fetchHeading.className = 'agent-virtualizer-debug-subheading';
    fetchHeading.textContent = 'Last 10 fetches';
    host.appendChild(fetchHeading);

    const list = document.createElement('ol');
    list.className = 'agent-virtualizer-debug-fetches';
    for (const fetch of debugState.recentFetches) {
      const item = document.createElement('li');
      const requested =
        fetch.requestedStart === null || fetch.requestedCount === null
          ? 'latest'
          : `req #${fetch.requestedStart + 1} x${fetch.requestedCount}`;
      item.textContent = `${fetch.reason} ${requested} -> #${fetch.returnedStart + 1}..#${fetch.returnedEnd} total ${fetch.historyCount}`;
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  function createHistoryEntry(
    entry: LensHistoryEntry,
    sessionId: string,
    options: {
      artifactCluster?: ArtifactClusterInfo | null;
      showAssistantBadge?: boolean;
    } = {},
  ): HTMLElement {
    const artifactCluster = options.artifactCluster ?? null;
    if (entry.busyIndicator) {
      return createBusyIndicatorEntry(entry);
    }

    const article = document.createElement('article');
    applyHistoryEntryChrome(article, entry, artifactCluster);

    if (artifactCluster?.label) {
      article.appendChild(createArtifactClusterLabel(artifactCluster));
    }

    article.appendChild(createHistoryHeader(entry, sessionId, options.showAssistantBadge === true));
    appendHistoryTitle(article, entry, sessionId);
    appendHistoryBody(article, entry, sessionId);

    const attachmentBlock = createHistoryAttachmentBlock(sessionId, entry.attachments);
    if (attachmentBlock) {
      article.appendChild(attachmentBlock);
    }

    if (entry.actions?.length) {
      article.appendChild(createHistoryActionBlock(sessionId, entry.actions));
    }

    return article;
  }

  function applyHistoryEntryChrome(
    article: HTMLElement,
    entry: LensHistoryEntry,
    artifactCluster: ArtifactClusterInfo | null,
  ): void {
    article.className = `agent-history-entry agent-history-${entry.kind} agent-history-${entry.tone}`;
    article.dataset.kind = entry.kind;
    article.dataset.tone = entry.tone;
    if (artifactCluster) {
      article.dataset.artifactPosition = artifactCluster.position;
      article.classList.add('agent-history-artifact');
    }
    if (entry.pending) {
      article.dataset.pending = 'true';
      article.classList.add('agent-history-pending');
    }
    if (entry.live) {
      article.dataset.live = 'true';
      article.classList.add('agent-history-live');
    }
    if (entry.turnDurationNote) {
      article.dataset.turnDurationNote = 'true';
      article.classList.add('agent-history-turn-duration');
    }
    if (entry.kind === 'tool' && hasInlineCommandPresentation(entry)) {
      article.dataset.commandEntry = 'true';
      article.classList.add('agent-history-command-entry');
    }
    if (entry.kind === 'assistant' && isAssistantPlaceholderEntry(entry)) {
      article.dataset.placeholder = 'true';
      article.classList.add('agent-history-assistant-placeholder');
    }
  }

  function createHistoryHeader(
    entry: LensHistoryEntry,
    sessionId: string,
    showAssistantBadge: boolean,
  ): HTMLElement {
    const header = document.createElement('div');
    header.className = 'agent-history-header';

    const badge = document.createElement('span');
    badge.className = `agent-history-badge agent-history-badge-${entry.kind}`;
    badge.textContent = resolveHistoryBadgeTextForEntry(
      entry,
      deps.getState(sessionId)?.snapshot?.provider,
    );
    if (entry.kind === 'assistant' && showAssistantBadge) {
      badge.dataset.visible = 'true';
    }
    header.appendChild(badge);

    if (entry.meta.trim()) {
      const meta = document.createElement('div');
      meta.className = 'agent-history-meta';
      meta.textContent = entry.meta;
      header.appendChild(meta);
    }

    return header;
  }

  function appendHistoryTitle(
    article: HTMLElement,
    entry: LensHistoryEntry,
    sessionId: string,
  ): void {
    const titleText = normalizeHistoryTitle(entry);
    if (!titleText) {
      return;
    }

    const title = document.createElement('div');
    title.className = 'agent-history-title';
    title.textContent = titleText;
    enrichInteractiveTextContent(title, getEntryFileMentions(entry, 'title'));
    wireAssistantInteractiveContent(title, sessionId);
    article.appendChild(title);
  }

  function appendHistoryBody(
    article: HTMLElement,
    entry: LensHistoryEntry,
    sessionId: string,
  ): void {
    if (
      appendInlineRequestWidgetToArticle({
        article,
        createRequestActionBlock,
        deps,
        entry,
        sessionId,
      })
    ) {
      return;
    }

    if (!shouldRenderHistoryBody(entry)) {
      return;
    }

    const presentation = resolveHistoryBodyPresentation(entry);
    article.appendChild(
      presentation.collapsedByDefault
        ? createCollapsedHistoryBody(entry, sessionId, presentation)
        : createHistoryBodyContent(entry, sessionId, presentation),
    );
  }

  function createHistoryBodyContent(
    entry: LensHistoryEntry,
    sessionId: string,
    presentation: HistoryBodyPresentation,
  ): HTMLElement {
    if (entry.turnDurationNote) {
      return createTurnDurationNoteBody(entry);
    }

    switch (presentation.mode) {
      case 'plain': {
        const body = document.createElement('div');
        body.className = 'agent-history-body';
        body.textContent = entry.body;
        enrichInteractiveTextContent(body, getEntryFileMentions(entry, 'body'));
        wireAssistantInteractiveContent(body, sessionId);
        appendEntryImagePreviews(body, entry, sessionId);
        return body;
      }
      case 'command':
        return createCommandHistoryBody(entry, sessionId);
      case 'streaming':
      case 'markdown': {
        const body = document.createElement('div');
        body.className = 'agent-history-body agent-history-markdown';
        const content = document.createElement('div');
        content.className = 'agent-history-markdown-content';
        const cache = getCachedAssistantMarkdown(sessionId, entry);
        content.innerHTML = cache.html;
        collapseSingleParagraphMarkdownBody(content);
        wireAssistantInteractiveContent(content, sessionId);
        wireMarkdownTables(content, {
          clearSort: (column) =>
            lensFormat('lens.markdownTable.clearSort', 'Clear sorting for {column}', { column }),
          filterByColumn: (column) =>
            lensFormat('lens.markdownTable.filterByColumn', 'Filter {column}', { column }),
          filterPlaceholder: lensText('lens.markdownTable.filterPlaceholder', 'Filter'),
          sortAscending: (column) =>
            lensFormat('lens.markdownTable.sortAscending', 'Sort {column} ascending', { column }),
          sortDescending: (column) =>
            lensFormat('lens.markdownTable.sortDescending', 'Sort {column} descending', {
              column,
            }),
        });
        body.appendChild(content);
        appendEntryImagePreviews(body, entry, sessionId);
        return body;
      }
      case 'diff':
        return createDiffHistoryBody(entry.body, sessionId);
      case 'monospace': {
        const body = document.createElement('pre');
        body.className = 'agent-history-body';
        body.textContent = entry.body;
        enrichInteractiveTextContent(body, getEntryFileMentions(entry, 'body'));
        wireAssistantInteractiveContent(body, sessionId);
        appendEntryImagePreviews(body, entry, sessionId);
        return body;
      }
    }
  }

  function createCommandHistoryBody(entry: LensHistoryEntry, sessionId: string): HTMLElement {
    const body = document.createElement('div');
    body.className = 'agent-history-body agent-history-command-body';
    const commandLine = document.createElement('div');
    commandLine.className = 'agent-history-command-line';
    const prefix = document.createElement('span');
    prefix.className = 'agent-history-command-prefix';
    prefix.textContent = 'Ran ';
    commandLine.appendChild(prefix);

    for (const token of tokenizeCommandText(entry.commandText ?? entry.body)) {
      const part = document.createElement('span');
      part.className = `agent-history-command-token agent-history-command-token-${token.kind}`;
      part.textContent = token.text;
      commandLine.appendChild(part);
    }
    enrichInteractiveTextContent(commandLine, getEntryFileMentions(entry, 'commandText'));
    wireAssistantInteractiveContent(commandLine, sessionId);

    body.appendChild(commandLine);
    if ((entry.commandOutputTail?.length ?? 0) > 0) {
      const output = document.createElement('pre');
      output.className = 'agent-history-command-output-tail';
      output.textContent = entry.commandOutputTail?.join('\n') ?? '';
      // Keep folded command tails as raw terminal text instead of applying
      // FileRadar-style enrichment or thumbnail previews to noisy output.
      body.appendChild(output);
    }

    return body;
  }

  function createBusyIndicatorEntry(entry: LensHistoryEntry): HTMLElement {
    const article = document.createElement('article');
    article.className = 'agent-history-entry agent-history-assistant agent-history-busy-indicator';
    article.dataset.kind = 'assistant';
    article.dataset.busyIndicator = 'true';
    const bubble = document.createElement('div');
    bubble.className = 'agent-history-busy-bubble';
    const glyph = document.createElement('span');
    glyph.className = 'agent-history-busy-glyph';
    glyph.innerHTML =
      '<svg class="agent-history-busy-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g class="agent-history-busy-spinner"><path class="agent-history-busy-triangle" d="M12 3.75 20 18.25H4L12 3.75Z" /><circle class="agent-history-busy-center" cx="12" cy="13" r="2.3" /></g></svg>';
    bubble.appendChild(glyph);

    const label = document.createElement('span');
    label.className = 'agent-history-busy-label';
    const labelText = entry.body || 'Working';
    label.dataset.text = labelText;
    const labelBase = document.createElement('span');
    labelBase.className = 'agent-history-busy-label-base';
    labelBase.textContent = labelText;
    label.appendChild(labelBase);
    const labelGlow = document.createElement('span');
    labelGlow.className = 'agent-history-busy-label-glow';
    labelGlow.setAttribute('aria-hidden', 'true');
    labelGlow.textContent = labelText;
    label.appendChild(labelGlow);
    bubble.appendChild(label);

    const status = document.createElement('span');
    status.className = 'agent-history-busy-status';
    const elapsed = document.createElement('span');
    elapsed.className = 'agent-history-busy-elapsed';
    elapsed.textContent = entry.busyElapsedText ?? '0s';
    status.appendChild(elapsed);
    const cancelHint = document.createElement('span');
    cancelHint.className = 'agent-history-busy-cancel';
    cancelHint.textContent = '(Press Esc to cancel)';
    status.appendChild(cancelHint);
    bubble.appendChild(status);
    article.appendChild(bubble);
    syncBusyIndicatorEntry(article, entry);
    return article;
  }

  function createDiffHistoryBody(bodyText: string, sessionId: string): HTMLElement {
    const body = document.createElement('div');
    body.className = 'agent-history-body agent-history-diff-body';
    const content = document.createElement('pre');
    content.className = 'agent-history-diff-content';
    const cwd = getSession(sessionId)?.currentDirectory?.trim();
    for (const line of buildRenderedDiffLines(bodyText, cwd && cwd.length > 0 ? cwd : null)) {
      const row = document.createElement('span');
      row.className = `agent-history-diff-line ${line.className}`;
      const hasLineNumbers =
        typeof line.oldLineNumber === 'number' || typeof line.newLineNumber === 'number';
      if (hasLineNumbers) {
        row.dataset.hasLineNumbers = 'true';
        row.appendChild(createDiffLineGutterNode(line.oldLineNumber, line.newLineNumber));
      }
      const text = document.createElement('span');
      text.className = 'agent-history-diff-line-text';
      text.textContent = line.text || ' ';
      row.appendChild(text);
      content.appendChild(row);
    }
    body.appendChild(content);
    return body;
  }

  function createCollapsedHistoryBody(
    entry: LensHistoryEntry,
    sessionId: string,
    presentation: HistoryBodyPresentation,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'agent-history-disclosure-shell';
    const details = document.createElement('details');
    details.className = 'agent-history-disclosure';
    details.open = deps.getState(sessionId)?.historyExpandedEntries.has(entry.id) === true;
    const summary = document.createElement('summary');
    summary.className = 'agent-history-disclosure-summary';
    const label = document.createElement('span');
    label.className = 'agent-history-disclosure-label';
    label.textContent = lensText('lens.panel.details', 'Details');
    summary.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'agent-history-disclosure-meta';
    meta.textContent = lensFormat('lens.panel.lines', '{count} lines', {
      count: presentation.lineCount,
    });
    summary.appendChild(meta);
    if (presentation.preview) {
      const preview = document.createElement('span');
      preview.className = 'agent-history-disclosure-preview';
      preview.textContent = presentation.preview;
      summary.appendChild(preview);
    }
    details.addEventListener('toggle', () => {
      const state = deps.getState(sessionId);
      if (!state) {
        return;
      }
      if (details.open) {
        state.historyExpandedEntries.add(entry.id);
      } else {
        state.historyExpandedEntries.delete(entry.id);
      }
    });
    details.append(summary, createHistoryBodyContent(entry, sessionId, presentation));
    wrapper.appendChild(details);
    return wrapper;
  }

  function createArtifactClusterLabel(cluster: ArtifactClusterInfo): HTMLElement {
    const label = document.createElement('div');
    label.className = 'agent-history-artifact-cluster-label';
    label.textContent =
      cluster.count > 1
        ? lensFormat('lens.cluster.withCount', '{label} ({count})', {
            label: cluster.label || '',
            count: cluster.count,
          })
        : cluster.label || '';
    return label;
  }

  function createHistoryActionBlock(
    sessionId: string,
    actions: readonly LensHistoryAction[],
  ): HTMLElement {
    const busy = deps.getState(sessionId)?.activationActionBusy === true;
    const row = document.createElement('div');
    row.className = 'agent-history-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        action.style === 'primary' ? 'agent-view-btn agent-view-btn-primary' : 'agent-view-btn';
      button.disabled = busy;
      button.textContent = busy ? action.busyLabel || action.label : action.label;
      button.addEventListener('click', () => {
        void deps.retryLensActivation(sessionId);
      });
      row.appendChild(button);
    }
    return row;
  }

  function createHistorySpacer(heightPx: number): HTMLElement {
    const spacer = document.createElement('div');
    spacer.className = 'agent-history-spacer';
    spacer.style.height = `${Math.max(0, Math.round(heightPx))}px`;
    return spacer;
  }

  function createHistoryPlaceholderBlock(args: {
    heightPx: number;
    itemCount: number;
    direction: 'earlier' | 'later';
    label: string;
    rangeLabel: string;
  }): HTMLElement {
    const block = document.createElement('div');
    block.className = 'agent-history-placeholder';
    block.dataset.direction = args.direction;
    block.style.height = `${Math.max(0, Math.round(args.heightPx))}px`;
    block.setAttribute(
      'aria-label',
      `${args.label}: ${args.itemCount} items represented by an estimated placeholder block`,
    );

    const chip = document.createElement('div');
    chip.className = 'agent-history-placeholder-chip';

    const title = document.createElement('span');
    title.className = 'agent-history-placeholder-title';
    title.textContent = args.label;
    chip.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'agent-history-placeholder-meta';
    meta.textContent = `${args.itemCount} items${args.rangeLabel ? ` • ${args.rangeLabel}` : ''}`;
    chip.appendChild(meta);

    block.appendChild(chip);
    return block;
  }

  function getCachedAssistantMarkdown(
    sessionId: string,
    entry: LensHistoryEntry,
  ): AssistantMarkdownCacheEntry {
    const fileMentions = getEntryFileMentions(entry, 'body');
    const fileMentionToken = fileMentions
      .map((mention) =>
        [
          mention.displayText,
          mention.path,
          mention.pathKind,
          mention.resolvedPath ?? '',
          mention.exists ? '1' : '0',
          mention.isDirectory ? '1' : '0',
        ].join(':'),
      )
      .join('|');
    const state = deps.getState(sessionId);
    if (!state) {
      const fallback = buildAssistantEnrichedHtml(renderMarkdownFragment(entry.body), fileMentions);
      return {
        body: entry.body,
        html: fallback.html,
        fileMentionToken,
      };
    }

    const existing = state.assistantMarkdownCache.get(entry.id);
    if (
      existing &&
      existing.body === entry.body &&
      existing.fileMentionToken === fileMentionToken
    ) {
      return existing;
    }

    const enriched = buildAssistantEnrichedHtml(renderMarkdownFragment(entry.body), fileMentions);
    const next: AssistantMarkdownCacheEntry = {
      body: entry.body,
      html: enriched.html,
      fileMentionToken,
    };
    state.assistantMarkdownCache.set(entry.id, next);
    return next;
  }

  function pruneAssistantMarkdownCache(
    state: SessionLensViewState,
    entries: readonly LensHistoryEntry[],
  ): void {
    if (state.assistantMarkdownCache.size === 0) {
      return;
    }

    const activeAssistantIds = new Set(
      entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.id),
    );

    for (const cacheKey of state.assistantMarkdownCache.keys()) {
      if (!activeAssistantIds.has(cacheKey)) {
        state.assistantMarkdownCache.delete(cacheKey);
      }
    }
  }

  function shouldRenderHistoryBody(entry: LensHistoryEntry): boolean {
    if (hasInlineCommandPresentation(entry)) {
      return true;
    }

    if (!entry.body.trim()) {
      return false;
    }

    if (isAssistantPlaceholderEntry(entry)) {
      return false;
    }

    return true;
  }

  function isAssistantPlaceholderEntry(entry: LensHistoryEntry): boolean {
    if (entry.kind !== 'assistant') {
      return false;
    }

    const normalized = entry.body.trim().toLowerCase();
    return (
      normalized === 'starting…' ||
      normalized === 'starting...' ||
      normalized === 'thinking…' ||
      normalized === 'thinking...'
    );
  }

  function createHistoryAttachmentBlock(
    sessionId: string,
    attachments: readonly LensAttachmentReference[] | undefined,
  ): HTMLElement | null {
    if (!attachments?.length) {
      return null;
    }

    const container = document.createElement('div');
    container.className = 'agent-history-attachments';

    for (const attachment of attachments) {
      const link = document.createElement('a');
      link.href = buildLensAttachmentUrl(sessionId, attachment);
      link.target = '_blank';
      link.rel = 'noreferrer';

      if (isImageAttachment(attachment)) {
        link.className = 'agent-history-attachment agent-history-attachment-image';
        const frame = document.createElement('span');
        frame.className = 'agent-history-attachment-image-frame';
        const image = document.createElement('img');
        image.className = 'agent-history-attachment-image-el';
        image.src = link.href;
        image.loading = 'lazy';
        image.alt = resolveAttachmentLabel(attachment);
        frame.appendChild(image);
        link.appendChild(frame);
        const caption = document.createElement('span');
        caption.className = 'agent-history-attachment-caption';
        caption.textContent = resolveAttachmentLabel(attachment);
        link.appendChild(caption);
      } else {
        link.className = 'agent-history-attachment agent-history-attachment-file';
        link.textContent = resolveAttachmentLabel(attachment);
      }

      container.appendChild(link);
    }

    return container;
  }

  function createRequestActionBlock(
    sessionId: string,
    request: LensHistoryRequestSummary,
    busy: boolean,
    state: SessionLensViewState,
    surface: 'composer' | 'history',
  ): HTMLElement {
    return createRequestActionBlockInternal({
      busy,
      deps,
      lensFormat,
      lensText,
      request,
      sessionId,
      surface,
      state,
    });
  }

  function formatTokenCount(value: number): string {
    if (value >= 1000) {
      const compact = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
      return `${compact.replace(/\.0$/, '')}k`;
    }

    return String(value);
  }

  function formatTokenWindowCompact(stats: LensRuntimeStatsSummary): string {
    if (stats.windowTokenLimit === null) {
      return '--';
    }

    if (stats.windowUsedTokens === null) {
      return `Window ${formatTokenCount(stats.windowTokenLimit)}`;
    }

    return `${formatTokenWindowPercent(stats.windowUsedTokens, stats.windowTokenLimit)} of ${formatTokenCount(stats.windowTokenLimit)}`;
  }

  function formatTokenWindowDetail(stats: LensRuntimeStatsSummary): string {
    if (stats.windowTokenLimit === null) {
      return 'Window --';
    }

    if (stats.windowUsedTokens === null) {
      return `Window ${formatTokenCount(stats.windowTokenLimit)}`;
    }

    return `Context ${formatTokenWindowPercent(stats.windowUsedTokens, stats.windowTokenLimit)} of ${formatTokenCount(stats.windowTokenLimit)} (${formatTokenCount(stats.windowUsedTokens)} used)`;
  }

  function formatTokenWindowPercent(usedTokens: number, windowTokenLimit: number): string {
    if (windowTokenLimit <= 0) {
      return '--';
    }

    const percent = (usedTokens / windowTokenLimit) * 100;
    if (!Number.isFinite(percent)) {
      return '--';
    }

    return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1).replace(/\.0$/, '')}%`;
  }

  function formatPercent(value: number | null): string {
    return value === null ? '--' : `${Math.round(value)}%`;
  }

  return {
    createHistoryEntry,
    createHistoryPlaceholderBlock,
    createHistorySpacer,
    createRequestActionBlock,
    pruneAssistantMarkdownCache,
    renderRuntimeStats,
    renderVirtualizerDebug,
    syncBusyIndicatorEntry,
  };
}
/* eslint-enable max-lines-per-function */
