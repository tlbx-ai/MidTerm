import { t } from '../i18n';
import { estimateHistoryEntryHeight } from './historyContent';
import { resolveHistoryBadgeLabel } from './activationHelpers';
import type { LensPulseRequestSummary, LensPulseSnapshotResponse } from '../../api/client';
import type {
  ArtifactClusterInfo,
  HistoryRenderPlan,
  HistoryScrollMetrics,
  HistoryViewportMetrics,
  HistoryVirtualWindow,
  HistoryVisibleEntry,
  LensHistoryEntry,
  SessionLensViewState,
} from './types';

const HISTORY_OVERSCAN_PX = 800;
const HISTORY_VIRTUALIZE_AFTER = 50;

function lensText(key: string, fallback: string): string {
  const translated = t(key);
  return !translated || translated === key ? fallback : translated;
}

type HistoryRenderDeps = {
  getState: (sessionId: string) => SessionLensViewState | undefined;
  scheduleHistoryRender: (sessionId: string) => void;
  syncAgentViewPresentation: (
    panel: HTMLDivElement,
    provider: LensPulseSnapshotResponse['provider'] | null | undefined,
  ) => void;
  createHistoryEntry: (
    entry: LensHistoryEntry,
    sessionId: string,
    artifactCluster?: ArtifactClusterInfo | null,
  ) => HTMLElement;
  createHistorySpacer: (heightPx: number) => HTMLElement;
  createRequestActionBlock: (
    sessionId: string,
    request: LensPulseRequestSummary,
    busy: boolean,
    state: SessionLensViewState,
  ) => HTMLElement;
  pruneAssistantMarkdownCache: (
    state: SessionLensViewState,
    entries: readonly LensHistoryEntry[],
  ) => void;
  renderRuntimeStats: (panel: HTMLDivElement, stats: SessionLensViewState['runtimeStats']) => void;
};

export function createAgentHistoryRender(deps: HistoryRenderDeps) {
  function renderActivationView(
    sessionId: string,
    panel: HTMLDivElement,
    state: SessionLensViewState,
    entries: LensHistoryEntry[],
  ): void {
    deps.syncAgentViewPresentation(panel, state.snapshot?.provider ?? null);
    panel.dataset.agentTurnId = '';
    deps.renderRuntimeStats(panel, state.runtimeStats);
    renderComposerInterruption(panel, sessionId, [], state);
    renderHistory(panel, entries, sessionId);
  }

  function renderHistory(
    panel: HTMLDivElement,
    entries: LensHistoryEntry[],
    sessionId: string,
  ): void {
    const container = panel.querySelector<HTMLElement>('[data-agent-field="history"]');
    if (!container) {
      return;
    }

    const state = deps.getState(sessionId);
    if (state) {
      state.historyViewport = container as HTMLDivElement;
      state.historyEntries = entries;
      state.historyLastScrollMetrics ??= readHistoryScrollMetrics(container as HTMLDivElement);
      deps.pruneAssistantMarkdownCache(state, entries);
      renderScrollToBottomControl(panel, state);
    }

    const viewport = container as HTMLDivElement;
    const metrics = readHistoryViewportMetrics(viewport);
    const renderPlan = buildHistoryRenderPlan(entries, metrics, state);
    reconcileHistoryRenderPlan(sessionId, viewport, renderPlan);

    if (state && state.pendingHistoryPrependOffsetPx > 0 && !state.historyAutoScrollPinned) {
      const restoreOffset = state.pendingHistoryPrependOffsetPx;
      state.pendingHistoryPrependOffsetPx = 0;
      window.requestAnimationFrame(() => {
        viewport.scrollTop += restoreOffset;
      });
    }

    if (state?.historyAutoScrollPinned) {
      window.requestAnimationFrame(() => {
        const currentViewport = state.historyViewport;
        if (!currentViewport) {
          return;
        }

        const previousScrollTop = currentViewport.scrollTop;
        currentViewport.scrollTop = currentViewport.scrollHeight;
        if (
          entries.length > HISTORY_VIRTUALIZE_AFTER &&
          Math.abs(currentViewport.scrollTop - previousScrollTop) > 1
        ) {
          deps.scheduleHistoryRender(sessionId);
        }

        const current = deps.getState(sessionId);
        if (current) {
          current.historyAutoScrollPinned = true;
          current.historyLastScrollMetrics = readHistoryScrollMetrics(currentViewport);
          renderScrollToBottomControl(panel, current);
        }
      });
    }
  }

  function buildHistoryRenderPlan(
    entries: readonly LensHistoryEntry[],
    metrics: HistoryViewportMetrics,
    state: SessionLensViewState | undefined,
  ): HistoryRenderPlan {
    if (entries.length === 0) {
      return {
        emptyStateText: lensText('lens.emptyHistory', 'No history entries yet.'),
        topSpacerPx: 0,
        bottomSpacerPx: 0,
        visibleEntries: [],
      };
    }

    const virtualWindow = computeHistoryVirtualWindow(
      entries,
      metrics.scrollTop,
      metrics.clientHeight,
      metrics.clientWidth,
    );
    const remoteAverageHeight =
      entries.length > 0
        ? entries.reduce(
            (sum, entry) => sum + estimateHistoryEntryHeight(entry, metrics.clientWidth),
            0,
          ) / entries.length
        : 92;
    const remoteTopSpacerPx = Math.max(
      0,
      Math.round((state?.snapshot?.historyWindowStart ?? 0) * remoteAverageHeight),
    );
    const totalHistoryCount = state?.snapshot?.totalHistoryCount ?? entries.length;
    const historyWindowEnd = state?.snapshot?.historyWindowEnd ?? entries.length;
    const remoteBottomCount = Math.max(0, totalHistoryCount - historyWindowEnd);
    const remoteBottomSpacerPx = Math.max(0, Math.round(remoteBottomCount * remoteAverageHeight));

    return {
      emptyStateText: null,
      topSpacerPx: remoteTopSpacerPx + virtualWindow.topSpacerPx,
      bottomSpacerPx: remoteBottomSpacerPx + virtualWindow.bottomSpacerPx,
      visibleEntries: entries
        .slice(virtualWindow.start, virtualWindow.end)
        .map((entry, visibleIndex) => {
          const absoluteIndex = virtualWindow.start + visibleIndex;
          const cluster = resolveArtifactCluster(entries, absoluteIndex);
          return {
            key: entry.id,
            entry,
            cluster,
            signature: buildHistoryEntrySignature(entry, cluster, state),
          };
        }),
    };
  }

  function buildHistoryEntrySignature(
    entry: LensHistoryEntry,
    cluster: ArtifactClusterInfo | null,
    state: SessionLensViewState | undefined,
  ): string {
    return [
      entry.kind,
      entry.tone,
      resolveHistoryBadgeLabel(entry.kind, state?.snapshot?.provider),
      entry.title,
      entry.body,
      entry.meta,
      entry.pending ? '1' : '0',
      entry.live ? '1' : '0',
      entry.busyIndicator ? '1' : '0',
      entry.busyElapsedText ?? '',
      entry.turnDurationNote ? '1' : '0',
      entry.sourceItemType ?? '',
      entry.commandText ?? '',
      (entry.commandOutputTail ?? []).join('\n'),
      buildHistoryAttachmentToken(entry),
      (entry.actions ?? [])
        .map((action) => [action.id, action.label, action.style, action.busyLabel ?? ''].join(':'))
        .join('|'),
      buildHistoryClusterToken(cluster),
      state?.activationActionBusy === true && (entry.actions?.length ?? 0) > 0 ? 'busy' : 'idle',
    ].join('||');
  }

  function buildHistoryAttachmentToken(entry: LensHistoryEntry): string {
    return (entry.attachments ?? [])
      .map((attachment) =>
        [attachment.kind, attachment.displayName, attachment.path, attachment.mimeType ?? ''].join(
          ':',
        ),
      )
      .join('|');
  }

  function buildHistoryClusterToken(cluster: ArtifactClusterInfo | null): string {
    return cluster
      ? [cluster.position, cluster.label ?? '', cluster.count, cluster.onlyTools ? '1' : '0'].join(
          ':',
        )
      : '';
  }

  function reconcileHistoryRenderPlan(
    sessionId: string,
    container: HTMLDivElement,
    plan: HistoryRenderPlan,
  ): void {
    const state = deps.getState(sessionId);
    if (!state) {
      return;
    }

    if (plan.emptyStateText) {
      const emptyNode = ensureEmptyHistoryNode(state, plan.emptyStateText);
      syncOrderedChildren(container, [emptyNode]);
      state.historyRenderedNodes.clear();
      state.historyTopSpacer = null;
      state.historyBottomSpacer = null;
      return;
    }

    state.historyEmptyState = null;
    const nextChildren: HTMLElement[] = [];
    if (plan.topSpacerPx > 0) {
      nextChildren.push(ensureHistorySpacerNode(state, 'top', plan.topSpacerPx));
    } else {
      state.historyTopSpacer = null;
    }

    const visibleKeys = new Set<string>();
    for (const visibleEntry of plan.visibleEntries) {
      visibleKeys.add(visibleEntry.key);
      nextChildren.push(resolveRenderedHistoryNode(sessionId, state, visibleEntry));
    }

    for (const cacheKey of state.historyRenderedNodes.keys()) {
      if (!visibleKeys.has(cacheKey)) {
        state.historyRenderedNodes.delete(cacheKey);
      }
    }

    if (plan.bottomSpacerPx > 0) {
      nextChildren.push(ensureHistorySpacerNode(state, 'bottom', plan.bottomSpacerPx));
    } else {
      state.historyBottomSpacer = null;
    }

    syncOrderedChildren(container, nextChildren);
  }

  function ensureEmptyHistoryNode(state: SessionLensViewState, text: string): HTMLDivElement {
    if (!state.historyEmptyState) {
      const empty = document.createElement('div');
      empty.className = 'agent-history-empty';
      state.historyEmptyState = empty;
    }
    state.historyEmptyState.textContent = text;
    return state.historyEmptyState;
  }

  function ensureHistorySpacerNode(
    state: SessionLensViewState,
    position: 'top' | 'bottom',
    heightPx: number,
  ): HTMLDivElement {
    const existing = position === 'top' ? state.historyTopSpacer : state.historyBottomSpacer;
    const spacer = existing ?? (deps.createHistorySpacer(0) as HTMLDivElement);
    spacer.style.height = `${Math.max(0, Math.round(heightPx))}px`;
    if (position === 'top') {
      state.historyTopSpacer = spacer;
    } else {
      state.historyBottomSpacer = spacer;
    }
    return spacer;
  }

  function resolveRenderedHistoryNode(
    sessionId: string,
    state: SessionLensViewState,
    visibleEntry: HistoryVisibleEntry,
  ): HTMLElement {
    const existing = state.historyRenderedNodes.get(visibleEntry.key);
    if (existing && existing.signature === visibleEntry.signature) {
      return existing.node;
    }

    const node = deps.createHistoryEntry(visibleEntry.entry, sessionId, visibleEntry.cluster);
    state.historyRenderedNodes.set(visibleEntry.key, {
      node,
      signature: visibleEntry.signature,
      entry: visibleEntry.entry,
      cluster: visibleEntry.cluster,
    });
    return node;
  }

  function syncOrderedChildren(container: HTMLElement, nodes: readonly HTMLElement[]): void {
    let anchor = container.firstChild;
    for (const node of nodes) {
      if (anchor !== node) {
        container.insertBefore(node, anchor);
      } else {
        anchor = anchor.nextSibling;
        continue;
      }

      anchor = node.nextSibling;
    }

    while (container.childNodes.length > nodes.length) {
      container.removeChild(container.lastChild as ChildNode);
    }
  }

  function renderScrollToBottomControl(panel: HTMLDivElement, state: SessionLensViewState): void {
    const button = panel.querySelector<HTMLButtonElement>('[data-agent-field="scroll-to-bottom"]');
    if (!button) {
      return;
    }

    button.textContent = lensText('lens.scrollToBottom', 'Back to bottom');
    button.hidden =
      state.historyAutoScrollPinned ||
      state.historyEntries.length === 0 ||
      state.activationState === 'failed';
  }

  function renderComposerInterruption(
    panel: HTMLDivElement,
    sessionId: string,
    requests: readonly LensPulseRequestSummary[],
    state: SessionLensViewState,
  ): void {
    const host = panel.querySelector<HTMLElement>('[data-agent-field="composer-interruption"]');
    if (!host) {
      return;
    }

    const activeRequest = findActiveComposerRequest(requests);
    if (!activeRequest) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }

    host.hidden = false;
    host.replaceChildren(
      deps.createRequestActionBlock(
        sessionId,
        activeRequest,
        state.requestBusyIds.has(activeRequest.requestId),
        state,
      ),
    );
  }

  function syncRequestInteractionState(
    state: SessionLensViewState,
    requests: readonly LensPulseRequestSummary[],
  ): void {
    const activeRequestIds = new Set(
      requests.filter((request) => request.state === 'open').map((request) => request.requestId),
    );

    for (const requestId of Object.keys(state.requestDraftAnswersById)) {
      if (!activeRequestIds.has(requestId)) {
        Reflect.deleteProperty(state.requestDraftAnswersById, requestId);
      }
    }

    for (const requestId of Object.keys(state.requestQuestionIndexById)) {
      if (!activeRequestIds.has(requestId)) {
        Reflect.deleteProperty(state.requestQuestionIndexById, requestId);
      }
    }
  }

  function readHistoryViewportMetrics(container: HTMLDivElement): HistoryViewportMetrics {
    return {
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      clientWidth: container.clientWidth,
    };
  }

  function readHistoryScrollMetrics(container: HTMLDivElement): HistoryScrollMetrics {
    return {
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
    };
  }

  function scrollHistoryToBottom(sessionId: string, behavior: ScrollBehavior = 'auto'): void {
    const state = deps.getState(sessionId);
    const viewport = state?.historyViewport;
    if (!state || !viewport) {
      return;
    }

    state.historyAutoScrollPinned = true;
    state.historyLastUserScrollIntentAt = 0;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
    state.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
    renderScrollToBottomControl(state.panel, state);
  }

  return {
    renderActivationView,
    renderComposerInterruption,
    renderHistory,
    renderScrollToBottomControl,
    readHistoryScrollMetrics,
    scrollHistoryToBottom,
    suppressActiveComposerRequestEntries,
    syncRequestInteractionState,
  };
}

export function suppressActiveComposerRequestEntries(
  entries: readonly LensHistoryEntry[],
  requests: readonly LensPulseRequestSummary[],
): LensHistoryEntry[] {
  const activeRequest = findActiveComposerRequest(requests);
  if (!activeRequest || activeRequest.state !== 'open') {
    return [...entries];
  }

  return entries.filter(
    (entry) => entry.kind !== 'request' || entry.requestId !== activeRequest.requestId,
  );
}

function findActiveComposerRequest(
  requests: readonly LensPulseRequestSummary[],
): LensPulseRequestSummary | null {
  const openRequests = requests.filter((request) => request.state === 'open');
  if (openRequests.length === 0) {
    return null;
  }

  return (
    openRequests
      .slice()
      .sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )[0] ?? null
  );
}

function computeHistoryVirtualWindow(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth = typeof window === 'undefined' ? 960 : window.innerWidth,
): HistoryVirtualWindow {
  if (entries.length <= HISTORY_VIRTUALIZE_AFTER) {
    return { start: 0, end: entries.length, topSpacerPx: 0, bottomSpacerPx: 0 };
  }

  const targetTop = Math.max(0, scrollTop - HISTORY_OVERSCAN_PX);
  const targetBottom = scrollTop + clientHeight + HISTORY_OVERSCAN_PX;
  let cumulative = 0;
  let start = 0;
  let topSpacerPx = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    const height = estimateHistoryEntryHeight(entry, clientWidth);
    if (cumulative + height >= targetTop) {
      start = index;
      topSpacerPx = cumulative;
      break;
    }
    cumulative += height;
  }

  cumulative = topSpacerPx;
  let end = start;
  while (end < entries.length && cumulative < targetBottom) {
    const entry = entries[end];
    if (!entry) {
      break;
    }
    cumulative += estimateHistoryEntryHeight(entry, clientWidth);
    end += 1;
  }

  const totalHeight = entries.reduce(
    (sum, entry) => sum + estimateHistoryEntryHeight(entry, clientWidth),
    0,
  );

  return {
    start,
    end: Math.max(end, start + 1),
    topSpacerPx,
    bottomSpacerPx: Math.max(0, totalHeight - cumulative),
  };
}

function resolveArtifactCluster(
  entries: readonly LensHistoryEntry[],
  index: number,
): ArtifactClusterInfo | null {
  const entry = entries[index];
  if (!entry || !['tool', 'reasoning', 'plan', 'diff'].includes(entry.kind)) {
    return null;
  }

  let start = index;
  while (
    start > 0 &&
    ['tool', 'reasoning', 'plan', 'diff'].includes(entries[start - 1]?.kind ?? '')
  ) {
    start -= 1;
  }

  let end = index;
  while (
    end + 1 < entries.length &&
    ['tool', 'reasoning', 'plan', 'diff'].includes(entries[end + 1]?.kind ?? '')
  ) {
    end += 1;
  }

  const count = end - start + 1;
  const position =
    count === 1 ? 'single' : index === start ? 'start' : index === end ? 'end' : 'middle';
  const clusterEntries = entries.slice(start, end + 1);
  const onlyTools = clusterEntries.every((candidate) => candidate.kind === 'tool');
  return {
    position,
    label: position === 'start' && !onlyTools ? lensText('lens.cluster.workLog', 'Work log') : null,
    count,
    onlyTools,
  };
}
