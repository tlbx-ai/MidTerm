import { t } from '../i18n';
import { getSession } from '../../stores';
import { showDevErrorDialog } from '../../utils/devErrorDialog';
import { renderMarkdownFragment } from '../../utils/markdown';
import {
  approveLensRequest,
  declineLensRequest,
  resolveLensUserInput,
  type LensPulseRequestSummary,
} from '../../api/client';
import type { LensAttachmentReference } from '../../api/types';
import {
  buildLensAttachmentUrl,
  isImageAttachment,
  resolveAttachmentLabel,
  resolveHistoryBadgeLabel,
} from './activationHelpers';
import {
  buildRenderedDiffLines,
  resolveHistoryBodyPresentation,
  tokenizeCommandText,
} from './historyContent';
import type {
  ArtifactClusterInfo,
  HistoryBodyPresentation,
  LensHistoryAction,
  LensHistoryEntry,
  LensRuntimeStatsSummary,
  SessionLensViewState,
} from './types';

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

type AgentHistoryDomDeps = {
  getState: (sessionId: string) => SessionLensViewState | undefined;
  refreshLensSnapshot: (sessionId: string) => Promise<void>;
  renderCurrentAgentView: (sessionId: string) => void;
  retryLensActivation: (sessionId: string) => Promise<void>;
  logWarn: (message: () => string) => void;
};

export function createAgentHistoryDom(deps: AgentHistoryDomDeps) {
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

  function createHistoryEntry(
    entry: LensHistoryEntry,
    sessionId: string,
    artifactCluster: ArtifactClusterInfo | null = null,
  ): HTMLElement {
    if (entry.busyIndicator) {
      return createBusyIndicatorEntry(entry);
    }

    const article = document.createElement('article');
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
    if (entry.kind === 'assistant' && isAssistantPlaceholderEntry(entry)) {
      article.dataset.placeholder = 'true';
      article.classList.add('agent-history-assistant-placeholder');
    }

    if (artifactCluster?.label) {
      article.appendChild(createArtifactClusterLabel(artifactCluster));
    }

    const header = document.createElement('div');
    header.className = 'agent-history-header';

    const badge = document.createElement('span');
    badge.className = `agent-history-badge agent-history-badge-${entry.kind}`;
    badge.textContent = resolveHistoryBadgeLabel(
      entry.kind,
      deps.getState(sessionId)?.snapshot?.provider,
    );
    header.appendChild(badge);

    if (entry.meta.trim()) {
      const meta = document.createElement('div');
      meta.className = 'agent-history-meta';
      meta.textContent = entry.meta;
      header.appendChild(meta);
    }
    article.appendChild(header);

    const titleText = normalizeHistoryTitle(entry);
    if (titleText) {
      const title = document.createElement('div');
      title.className = 'agent-history-title';
      title.textContent = titleText;
      article.appendChild(title);
    }

    if (shouldRenderHistoryBody(entry)) {
      const presentation = resolveHistoryBodyPresentation(entry);
      article.appendChild(
        presentation.collapsedByDefault
          ? createCollapsedHistoryBody(entry, sessionId, presentation)
          : createHistoryBodyContent(entry, sessionId, presentation),
      );
    }

    const attachmentBlock = createHistoryAttachmentBlock(sessionId, entry.attachments);
    if (attachmentBlock) {
      article.appendChild(attachmentBlock);
    }

    if (entry.actions?.length) {
      article.appendChild(createHistoryActionBlock(sessionId, entry.actions));
    }

    return article;
  }

  function createHistoryBodyContent(
    entry: LensHistoryEntry,
    sessionId: string,
    presentation: HistoryBodyPresentation,
  ): HTMLElement {
    switch (presentation.mode) {
      case 'command':
        return createCommandHistoryBody(entry);
      case 'streaming': {
        const body = document.createElement('div');
        body.className = 'agent-history-body agent-history-streaming-body';
        body.textContent = entry.body;
        return body;
      }
      case 'markdown': {
        const body = document.createElement('div');
        body.className = 'agent-history-body agent-history-markdown';
        const content = document.createElement('div');
        content.className = 'agent-history-markdown-content';
        content.innerHTML = getCachedAssistantMarkdownHtml(sessionId, entry);
        collapseSingleParagraphMarkdownBody(content);
        body.appendChild(content);
        return body;
      }
      case 'diff':
        return createDiffHistoryBody(entry.body, sessionId);
      case 'monospace': {
        const body = document.createElement('pre');
        body.className = 'agent-history-body';
        body.textContent = entry.body;
        return body;
      }
      default: {
        const body = document.createElement('div');
        body.className = 'agent-history-body';
        body.textContent = entry.body;
        return body;
      }
    }
  }

  function createCommandHistoryBody(entry: LensHistoryEntry): HTMLElement {
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

    body.appendChild(commandLine);
    if ((entry.commandOutputTail?.length ?? 0) > 0) {
      const output = document.createElement('pre');
      output.className = 'agent-history-command-output-tail';
      output.textContent = entry.commandOutputTail?.join('\n') ?? '';
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
    for (const [index, character] of Array.from(entry.body || 'Working').entries()) {
      const letter = document.createElement('span');
      letter.className = 'agent-history-busy-label-letter';
      if (typeof letter.style.setProperty === 'function') {
        letter.style.setProperty('--agent-busy-letter-index', String(index));
      } else {
        const style = letter.style as CSSStyleDeclaration & Record<string, string>;
        style['--agent-busy-letter-index'] = String(index);
      }
      letter.textContent = character;
      label.appendChild(letter);
    }
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
      row.appendChild(createDiffLineNumberNode(line.oldLineNumber));
      row.appendChild(createDiffLineNumberNode(line.newLineNumber));
      const text = document.createElement('span');
      text.className = 'agent-history-diff-line-text';
      text.textContent = line.text || ' ';
      row.appendChild(text);
      content.appendChild(row);
    }
    body.appendChild(content);
    return body;
  }

  function createDiffLineNumberNode(value: number | undefined): HTMLElement {
    const cell = document.createElement('span');
    cell.className = 'agent-history-diff-line-number';
    if (typeof value === 'number' && Number.isFinite(value)) {
      cell.textContent = String(value);
    } else {
      cell.textContent = '';
      cell.setAttribute('aria-hidden', 'true');
    }
    return cell;
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

  function getCachedAssistantMarkdownHtml(sessionId: string, entry: LensHistoryEntry): string {
    const state = deps.getState(sessionId);
    if (!state) {
      return renderMarkdownFragment(entry.body);
    }

    const existing = state.assistantMarkdownCache.get(entry.id);
    if (existing && existing.body === entry.body) {
      return existing.html;
    }

    const html = renderMarkdownFragment(entry.body);
    state.assistantMarkdownCache.set(entry.id, { body: entry.body, html });
    return html;
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
        const image = document.createElement('img');
        image.className = 'agent-history-attachment-image-el';
        image.src = link.href;
        image.loading = 'lazy';
        image.alt = resolveAttachmentLabel(attachment);
        link.appendChild(image);
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
    request: LensPulseRequestSummary,
    busy: boolean,
    state: SessionLensViewState,
  ): HTMLElement {
    const actions = document.createElement('div');
    const isUserInputRequest = request.kind === 'tool_user_input' && request.questions.length > 0;
    actions.className = `agent-request-actions agent-request-actions-composer ${isUserInputRequest ? 'agent-request-actions-user-input' : 'agent-request-actions-approval'}`;
    const panel = document.createElement('section');
    panel.className = `agent-request-panel ${isUserInputRequest ? 'agent-request-panel-user-input' : 'agent-request-panel-approval'}`;
    panel.appendChild(createRequestPanelHeader(request));

    if (isUserInputRequest) {
      const draftAnswers = ensureRequestDraftAnswers(state, request);
      const activeQuestionIndex = resolveActiveRequestQuestionIndex(state, request);
      const activeQuestion = request.questions[activeQuestionIndex];
      if (!activeQuestion) {
        actions.appendChild(panel);
        return actions;
      }

      const form = document.createElement('form');
      form.className = 'agent-request-form';
      form.appendChild(
        createQuestionField(
          sessionId,
          request,
          activeQuestion,
          activeQuestionIndex,
          request.questions.length,
          draftAnswers,
        ),
      );

      const controls = document.createElement('div');
      controls.className = 'agent-request-button-row';
      if (activeQuestionIndex > 0) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'agent-view-btn';
        back.disabled = busy;
        back.textContent = lensText('lens.request.back', 'Back');
        back.addEventListener('click', () => {
          setActiveRequestQuestionIndex(sessionId, request.requestId, activeQuestionIndex - 1);
        });
        controls.appendChild(back);
      }

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.className = 'agent-view-btn agent-view-btn-primary';
      submit.disabled = busy || !hasDraftAnswerForQuestion(draftAnswers, activeQuestion);
      submit.textContent =
        activeQuestionIndex < request.questions.length - 1
          ? lensText('lens.request.continue', 'Continue')
          : busy
            ? lensText('lens.request.sending', 'Sending…')
            : lensText('lens.request.sendAnswer', 'Send answer');
      controls.appendChild(submit);
      form.appendChild(controls);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (activeQuestionIndex < request.questions.length - 1) {
          setActiveRequestQuestionIndex(sessionId, request.requestId, activeQuestionIndex + 1);
          return;
        }

        void handleResolveUserInput(
          sessionId,
          request.requestId,
          collectQuestionAnswers(state, request),
        );
      });

      panel.appendChild(form);
      actions.appendChild(panel);
      return actions;
    }

    const buttonRow = document.createElement('div');
    buttonRow.className = 'agent-request-button-row';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'agent-view-btn agent-view-btn-primary';
    approve.disabled = busy;
    approve.textContent = busy
      ? lensText('lens.request.working', 'Working…')
      : lensText('lens.request.approveOnce', 'Approve once');
    approve.addEventListener('click', () => {
      void runRequestAction(sessionId, request.requestId, () =>
        approveLensRequest(sessionId, request.requestId),
      );
    });

    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'agent-view-btn';
    decline.disabled = busy;
    decline.textContent = lensText('lens.request.decline', 'Decline');
    decline.addEventListener('click', () => {
      void runRequestAction(sessionId, request.requestId, () =>
        declineLensRequest(sessionId, request.requestId),
      );
    });

    buttonRow.append(approve, decline);
    panel.appendChild(buttonRow);
    actions.appendChild(panel);
    return actions;
  }

  function createRequestPanelHeader(request: LensPulseRequestSummary): HTMLElement {
    const header = document.createElement('div');
    header.className = 'agent-request-panel-header';
    const topRow = document.createElement('div');
    topRow.className = 'agent-request-panel-topline';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'agent-request-eyebrow';
    eyebrow.textContent =
      request.kind === 'tool_user_input'
        ? lensText('lens.request.pendingUserInput', 'Pending user input')
        : lensText('lens.request.pendingApproval', 'Pending approval');
    topRow.appendChild(eyebrow);

    const summary = document.createElement('span');
    summary.className = 'agent-request-summary';
    summary.textContent = summarizeRequestInterruption(request);
    topRow.appendChild(summary);
    header.appendChild(topRow);

    if (request.detail?.trim()) {
      const detail = document.createElement('p');
      detail.className = 'agent-request-detail';
      detail.textContent = request.detail;
      header.appendChild(detail);
    }

    return header;
  }

  function summarizeRequestInterruption(request: LensPulseRequestSummary): string {
    if (request.kind === 'tool_user_input') {
      const activeQuestion = request.questions[0];
      if (request.questions.length === 1 && activeQuestion?.options.length) {
        return activeQuestion.multiSelect
          ? lensFormat(
              'lens.request.selectManyToContinue',
              'Select one or more of {count} options to continue.',
              { count: activeQuestion.options.length },
            )
          : lensFormat(
              'lens.request.selectOneToContinue',
              'Select 1 of {count} options to continue.',
              { count: activeQuestion.options.length },
            );
      }

      return request.questions.length === 1
        ? lensText('lens.request.needsOneAnswer', 'The agent needs one answer to continue.')
        : lensFormat(
            'lens.request.needsManyAnswers',
            'The agent needs {count} answers to continue.',
            { count: request.questions.length },
          );
    }

    const label = request.kindLabel.trim() || lensText('lens.request.approvalLabel', 'Approval');
    return lensFormat(
      'lens.request.requiredBeforeContinue',
      '{label} required before the turn can continue.',
      { label },
    );
  }

  function createQuestionField(
    sessionId: string,
    request: LensPulseRequestSummary,
    question: LensPulseRequestSummary['questions'][number],
    index: number,
    totalQuestions: number,
    draftAnswers: Record<string, string[]>,
  ): HTMLElement {
    const wrapper = document.createElement('section');
    wrapper.className = 'agent-request-field';

    if (question.header && question.header.trim()) {
      const header = document.createElement('div');
      header.className = 'agent-request-field-header';
      const fieldHeader = document.createElement('span');
      fieldHeader.className = 'agent-request-field-label';
      fieldHeader.textContent = question.header;
      header.appendChild(fieldHeader);
      wrapper.appendChild(header);
    }

    const title = document.createElement('p');
    title.className = 'agent-request-question';
    title.textContent = question.question;
    wrapper.appendChild(title);

    const draftValue = draftAnswers[question.id] ?? [];
    if (question.options.length > 0 && question.multiSelect) {
      wrapper.appendChild(
        createQuestionChoiceList(sessionId, request, question, 'checkbox', draftValue, false),
      );
      return wrapper;
    }

    if (question.options.length > 0) {
      wrapper.appendChild(
        createQuestionChoiceList(
          sessionId,
          request,
          question,
          'radio',
          draftValue,
          index < totalQuestions - 1,
        ),
      );
      return wrapper;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.name = question.id;
    input.className = 'agent-request-input';
    input.placeholder = lensText('lens.request.typeAnswer', 'Type answer');
    input.value = draftValue[0] || '';
    input.addEventListener('input', () => {
      updateRequestDraftAnswers(sessionId, request.requestId, question.id, [input.value.trim()]);
    });
    wrapper.appendChild(input);
    return wrapper;
  }

  function createQuestionChoiceList(
    sessionId: string,
    request: LensPulseRequestSummary,
    question: LensPulseRequestSummary['questions'][number],
    inputType: 'checkbox' | 'radio',
    selectedAnswers: readonly string[],
    autoAdvance: boolean,
  ): HTMLElement {
    const options = document.createElement('div');
    options.className = 'agent-request-choice-list';

    for (const [index, option] of question.options.entries()) {
      const optionLabel = document.createElement('label');
      optionLabel.className = 'agent-request-choice';
      const input = document.createElement('input');
      input.type = inputType;
      input.name = question.id;
      input.value = option.label;
      input.className = 'agent-request-choice-input';
      input.checked = selectedAnswers.includes(option.label);
      input.addEventListener('change', () => {
        if (inputType === 'radio') {
          updateRequestDraftAnswers(
            sessionId,
            request.requestId,
            question.id,
            [option.label],
            false,
          );
          if (autoAdvance) {
            const currentIndex =
              deps.getState(sessionId)?.requestQuestionIndexById[request.requestId] ?? 0;
            setActiveRequestQuestionIndex(sessionId, request.requestId, currentIndex + 1);
            return;
          }

          deps.renderCurrentAgentView(sessionId);
          return;
        }

        const nextAnswers = Array.from(
          options.querySelectorAll<HTMLInputElement>(
            `input[name="${CSS.escape(question.id)}"]:checked`,
          ),
        ).map((candidate) => candidate.value);
        updateRequestDraftAnswers(sessionId, request.requestId, question.id, nextAnswers);
      });
      optionLabel.appendChild(input);

      if (index < 9) {
        const shortcut = document.createElement('span');
        shortcut.className = 'agent-request-choice-shortcut';
        shortcut.textContent = String(index + 1);
        optionLabel.appendChild(shortcut);
      }

      const copy = document.createElement('span');
      copy.className = 'agent-request-choice-copy';
      const title = document.createElement('span');
      title.className = 'agent-request-choice-title';
      title.textContent = option.label;
      copy.appendChild(title);
      if (option.description && option.description !== option.label) {
        const description = document.createElement('span');
        description.className = 'agent-request-choice-description';
        description.textContent = option.description;
        copy.appendChild(description);
      }

      optionLabel.appendChild(copy);
      options.appendChild(optionLabel);
    }

    return options;
  }

  function collectQuestionAnswers(
    state: SessionLensViewState,
    request: LensPulseRequestSummary,
  ): Array<{ questionId: string; answers: string[] }> {
    const draftAnswers = ensureRequestDraftAnswers(state, request);
    return request.questions.map((question) => ({
      questionId: question.id,
      answers: (draftAnswers[question.id] ?? []).filter(Boolean),
    }));
  }

  function resolveActiveRequestQuestionIndex(
    state: SessionLensViewState,
    request: LensPulseRequestSummary,
  ): number {
    const maxIndex = Math.max(0, request.questions.length - 1);
    const currentIndex = state.requestQuestionIndexById[request.requestId] ?? 0;
    return Math.max(0, Math.min(currentIndex, maxIndex));
  }

  function setActiveRequestQuestionIndex(
    sessionId: string,
    requestId: string,
    nextIndex: number,
  ): void {
    const state = deps.getState(sessionId);
    if (!state) {
      return;
    }

    state.requestQuestionIndexById[requestId] = Math.max(0, nextIndex);
    deps.renderCurrentAgentView(sessionId);
  }

  function ensureRequestDraftAnswers(
    state: SessionLensViewState,
    request: LensPulseRequestSummary,
  ): Record<string, string[]> {
    const existing = state.requestDraftAnswersById[request.requestId];
    if (existing) {
      for (const question of request.questions) {
        existing[question.id] ??= [];
      }
      return existing;
    }

    const nextDraft: Record<string, string[]> = {};
    for (const question of request.questions) {
      nextDraft[question.id] = [];
    }

    state.requestDraftAnswersById[request.requestId] = nextDraft;
    return nextDraft;
  }

  function updateRequestDraftAnswers(
    sessionId: string,
    requestId: string,
    questionId: string,
    answers: string[],
    rerender = true,
  ): void {
    const state = deps.getState(sessionId);
    if (!state) {
      return;
    }

    const requestDrafts = state.requestDraftAnswersById[requestId] ?? {};
    requestDrafts[questionId] = answers.filter((answer) => answer.trim().length > 0);
    state.requestDraftAnswersById[requestId] = requestDrafts;
    if (rerender) {
      deps.renderCurrentAgentView(sessionId);
    }
  }

  function hasDraftAnswerForQuestion(
    draftAnswers: Record<string, string[]>,
    question: LensPulseRequestSummary['questions'][number],
  ): boolean {
    return (draftAnswers[question.id] ?? []).some((answer) => answer.trim().length > 0);
  }

  async function handleResolveUserInput(
    sessionId: string,
    requestId: string,
    answers: Array<{ questionId: string; answers: string[] }>,
  ): Promise<void> {
    await runRequestAction(sessionId, requestId, () =>
      resolveLensUserInput(sessionId, requestId, {
        answers: answers.filter((answer) => answer.answers.length > 0),
      }),
    );
  }

  async function runRequestAction(
    sessionId: string,
    requestId: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    const state = deps.getState(sessionId);
    if (!state || state.requestBusyIds.has(requestId)) {
      return;
    }

    state.requestBusyIds.add(requestId);
    deps.renderCurrentAgentView(sessionId);
    try {
      await action();
      await deps.refreshLensSnapshot(sessionId);
    } catch (error) {
      deps.logWarn(
        () => `Failed to resolve Lens request ${requestId} for ${sessionId}: ${String(error)}`,
      );
      showDevErrorDialog({
        title: lensText('lens.error.requestTitle', 'Lens request failed'),
        context: `Lens request action failed for session ${sessionId}, request ${requestId}`,
        error,
      });
    } finally {
      state.requestBusyIds.delete(requestId);
      deps.renderCurrentAgentView(sessionId);
    }
  }

  function formatTokenCount(value: number): string {
    if (value >= 1000) {
      const compact = (value / 1000).toFixed(value >= 100000 ? 0 : 1);
      return `${compact.replace(/\.0$/, '')}k`;
    }

    return String(value);
  }

  function formatTokenWindowCompact(stats: LensRuntimeStatsSummary): string {
    if (stats.windowUsedTokens === null || stats.windowTokenLimit === null) {
      return '-- of --';
    }

    return `${formatTokenWindowPercent(stats.windowUsedTokens, stats.windowTokenLimit)} of ${formatTokenCount(stats.windowTokenLimit)}`;
  }

  function formatTokenWindowDetail(stats: LensRuntimeStatsSummary): string {
    if (stats.windowUsedTokens === null || stats.windowTokenLimit === null) {
      return 'Context -- of --';
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
    createHistorySpacer,
    createRequestActionBlock,
    pruneAssistantMarkdownCache,
    renderRuntimeStats,
  };
}
