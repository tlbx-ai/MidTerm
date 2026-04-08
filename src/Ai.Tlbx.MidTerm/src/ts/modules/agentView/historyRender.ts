import { t } from '../i18n';
import { estimateHistoryEntryHeight } from './historyContent';
import { resolveHistoryBadgeLabel } from './activationHelpers';
import {
  buildHistoryVirtualWindowKey,
  computeHistoryVirtualWindow,
  HISTORY_VIRTUALIZE_AFTER,
} from './historyViewport';
import type { LensPulseRequestSummary, LensPulseSnapshotResponse } from '../../api/client';
import type {
  ArtifactClusterInfo,
  HistoryRenderPlan,
  HistoryScrollMetrics,
  HistoryViewportMetrics,
  HistoryVisibleEntry,
  LensHistoryEntry,
  SessionLensViewState,
} from './types';

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
  function syncViewportScrollPosition(viewport: HTMLDivElement, targetScrollTop: number): boolean {
    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
    if (Math.abs(nextScrollTop - viewport.scrollTop) <= 1) {
      return false;
    }

    viewport.scrollTop = nextScrollTop;
    return Math.abs(viewport.scrollTop - nextScrollTop) <= 1;
  }

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
    const measurementChanged = state
      ? measureRenderedHistoryHeights(state, renderPlan.visibleEntries, metrics.clientWidth)
      : false;
    finalizeRenderedHistoryState(sessionId, panel, viewport, entries, state, measurementChanged);
  }

  function buildHistoryRenderPlan(
    entries: readonly LensHistoryEntry[],
    metrics: HistoryViewportMetrics,
    state: SessionLensViewState | undefined,
  ): HistoryRenderPlan {
    if (entries.length === 0) {
      return {
        emptyStateText: lensText('lens.emptyHistory', 'No history entries yet.'),
        virtualWindowKey: null,
        topSpacerPx: 0,
        bottomSpacerPx: 0,
        visibleEntries: [],
      };
    }

    const resolveEntryHeight = (entry: LensHistoryEntry) =>
      resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth);
    const virtualWindow = computeHistoryVirtualWindow(
      entries,
      metrics.scrollTop,
      metrics.clientHeight,
      metrics.clientWidth,
      resolveEntryHeight,
    );
    const remoteTopSpacerPx = Math.max(0, state?.snapshot?.estimatedHistoryBeforeWindowPx ?? 0);
    const remoteBottomSpacerPx = Math.max(0, state?.snapshot?.estimatedHistoryAfterWindowPx ?? 0);

    return {
      emptyStateText: null,
      virtualWindowKey: buildHistoryVirtualWindowKey(virtualWindow),
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

  function resolveHistoryMeasurementWidthBucket(clientWidth: number): number {
    return Math.max(240, Math.round(clientWidth / 40) * 40);
  }

  function resolveHistoryViewportEntryHeight(
    entry: LensHistoryEntry,
    state: SessionLensViewState | undefined,
    clientWidth: number,
  ): number {
    if (!state) {
      return estimateHistoryEntryHeight(entry, clientWidth);
    }

    const widthBucket = resolveHistoryMeasurementWidthBucket(clientWidth);
    if (state.historyMeasuredWidthBucket !== widthBucket) {
      state.historyMeasuredWidthBucket = widthBucket;
      state.historyMeasuredHeights.clear();
      state.historyLastVirtualWindowKey = null;
    }

    return (
      state.historyMeasuredHeights.get(entry.id) ?? estimateHistoryEntryHeight(entry, clientWidth)
    );
  }

  function finalizeRenderedHistoryState(
    sessionId: string,
    panel: HTMLDivElement,
    viewport: HTMLDivElement,
    entries: readonly LensHistoryEntry[],
    state: SessionLensViewState | undefined,
    measurementChanged: boolean,
  ): void {
    const scrollAdjusted =
      state && state.pendingHistoryPrependAnchor && !state.historyAutoScrollPinned
        ? restorePendingHistoryAnchor(viewport, state)
        : false;

    if (state?.historyAutoScrollPinned) {
      syncPinnedHistoryViewport(sessionId, panel, viewport, entries.length);
    } else if (state && scrollAdjusted) {
      state.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
      renderScrollToBottomControl(panel, state);
    }

    if (measurementChanged && entries.length > HISTORY_VIRTUALIZE_AFTER) {
      deps.scheduleHistoryRender(sessionId);
    }
  }

  function syncPinnedHistoryViewport(
    sessionId: string,
    panel: HTMLDivElement,
    viewport: HTMLDivElement,
    entryCount: number,
  ): void {
    const didAutoScroll = syncViewportScrollPosition(
      viewport,
      viewport.scrollHeight - viewport.clientHeight,
    );
    if (didAutoScroll && entryCount > HISTORY_VIRTUALIZE_AFTER) {
      deps.scheduleHistoryRender(sessionId);
    }

    const current = deps.getState(sessionId);
    if (!current) {
      return;
    }

    current.historyAutoScrollPinned = true;
    current.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
    renderScrollToBottomControl(panel, current);
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
      buildAssistantPreviewToken(entry, state),
      buildHistoryActionToken(entry),
      buildHistoryClusterToken(cluster),
      resolveHistoryEntryBusyToken(entry, state),
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

  function buildAssistantPreviewToken(
    entry: LensHistoryEntry,
    state: SessionLensViewState | undefined,
  ): string {
    void state;
    return (entry.imagePreviews ?? []).map((preview) => preview.resolvedPath).join('|');
  }

  function buildHistoryClusterToken(cluster: ArtifactClusterInfo | null): string {
    return cluster
      ? [cluster.position, cluster.label ?? '', cluster.count, cluster.onlyTools ? '1' : '0'].join(
          ':',
        )
      : '';
  }

  function buildHistoryActionToken(entry: LensHistoryEntry): string {
    return (entry.actions ?? [])
      .map((action) => [action.id, action.label, action.style, action.busyLabel ?? ''].join(':'))
      .join('|');
  }

  function resolveHistoryEntryBusyToken(
    entry: LensHistoryEntry,
    state: SessionLensViewState | undefined,
  ): string {
    return state?.activationActionBusy === true && (entry.actions?.length ?? 0) > 0
      ? 'busy'
      : 'idle';
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
    state.historyLastVirtualWindowKey = plan.virtualWindowKey;
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

  function measureRenderedHistoryHeights(
    state: SessionLensViewState,
    visibleEntries: readonly HistoryVisibleEntry[],
    clientWidth: number,
  ): boolean {
    const widthBucket = resolveHistoryMeasurementWidthBucket(clientWidth);
    if (state.historyMeasuredWidthBucket !== widthBucket) {
      state.historyMeasuredWidthBucket = widthBucket;
      state.historyMeasuredHeights.clear();
      state.historyLastVirtualWindowKey = null;
    }

    let changed = false;
    for (const visibleEntry of visibleEntries) {
      const rendered = state.historyRenderedNodes.get(visibleEntry.key);
      if (!rendered?.node || typeof rendered.node.getBoundingClientRect !== 'function') {
        continue;
      }

      const measuredHeight = Math.max(1, Math.round(rendered.node.getBoundingClientRect().height));
      const previousHeight = state.historyMeasuredHeights.get(visibleEntry.key);
      if (previousHeight !== measuredHeight) {
        state.historyMeasuredHeights.set(visibleEntry.key, measuredHeight);
        changed = true;
      }
    }

    if (changed) {
      state.historyLastVirtualWindowKey = null;
    }

    return changed;
  }

  function restorePendingHistoryAnchor(
    viewport: HTMLDivElement,
    state: SessionLensViewState,
  ): boolean {
    const anchor = state.pendingHistoryPrependAnchor;
    if (!anchor) {
      return false;
    }

    const anchorNode = state.historyRenderedNodes.get(anchor.entryId)?.node;
    if (!anchorNode || typeof anchorNode.getBoundingClientRect !== 'function') {
      return false;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const anchorRect = anchorNode.getBoundingClientRect();
    state.pendingHistoryPrependAnchor = null;
    return syncViewportScrollPosition(
      viewport,
      viewport.scrollTop + (anchorRect.top - viewportRect.top - anchor.topOffsetPx),
    );
  }

  function captureHistoryViewportAnchor(state: SessionLensViewState): boolean {
    const viewport = state.historyViewport;
    if (!viewport) {
      state.pendingHistoryPrependAnchor = null;
      return false;
    }

    const viewportRect = viewport.getBoundingClientRect();
    let bestAnchor: { entryId: string; topOffsetPx: number } | null = null;
    for (const [entryId, rendered] of state.historyRenderedNodes) {
      if (typeof rendered.node.getBoundingClientRect !== 'function') {
        continue;
      }

      const nodeRect = rendered.node.getBoundingClientRect();
      if (nodeRect.bottom < viewportRect.top || nodeRect.top > viewportRect.bottom) {
        continue;
      }

      const topOffsetPx = nodeRect.top - viewportRect.top;
      if (!bestAnchor || topOffsetPx < bestAnchor.topOffsetPx) {
        bestAnchor = { entryId, topOffsetPx };
      }
    }

    state.pendingHistoryPrependAnchor = bestAnchor;
    return bestAnchor !== null;
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
    const shell = panel.querySelector<HTMLElement>('[data-agent-field="composer-shell"]');
    const host = panel.querySelector<HTMLElement>('[data-agent-field="composer-interruption"]');
    if (!shell || !host) {
      return;
    }

    const activeRequest = findActiveComposerRequest(requests);
    if (!activeRequest) {
      shell.hidden = true;
      host.hidden = true;
      host.replaceChildren();
      return;
    }

    shell.hidden = false;
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

  function shouldRenderForViewportScroll(state: SessionLensViewState): boolean {
    const viewport = state.historyViewport;
    if (!viewport || state.historyEntries.length <= HISTORY_VIRTUALIZE_AFTER) {
      return false;
    }

    const metrics = readHistoryViewportMetrics(viewport);
    const virtualWindow = computeHistoryVirtualWindow(
      state.historyEntries,
      metrics.scrollTop,
      metrics.clientHeight,
      metrics.clientWidth,
      (entry) => resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth),
    );
    return buildHistoryVirtualWindowKey(virtualWindow) !== state.historyLastVirtualWindowKey;
  }

  return {
    captureHistoryViewportAnchor,
    renderActivationView,
    renderComposerInterruption,
    renderHistory,
    renderScrollToBottomControl,
    readHistoryScrollMetrics,
    scrollHistoryToBottom,
    shouldRenderForViewportScroll,
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

function resolveArtifactCluster(
  entries: readonly LensHistoryEntry[],
  index: number,
): ArtifactClusterInfo | null {
  const entry = entries[index];
  if (!entry || !isArtifactClusterKind(entry.kind)) {
    return null;
  }

  const start = findArtifactClusterBoundary(entries, index, -1);
  const end = findArtifactClusterBoundary(entries, index, 1);

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

function isArtifactClusterKind(kind: LensHistoryEntry['kind']): boolean {
  return ['tool', 'reasoning', 'plan', 'diff'].includes(kind);
}

function findArtifactClusterBoundary(
  entries: readonly LensHistoryEntry[],
  index: number,
  direction: -1 | 1,
): number {
  let boundary = index;
  for (;;) {
    const nextIndex = boundary + direction;
    if (nextIndex < 0 || nextIndex >= entries.length) {
      return boundary;
    }
    const nextEntry = entries[nextIndex];
    if (!nextEntry || !isArtifactClusterKind(nextEntry.kind)) {
      return boundary;
    }
    boundary = nextIndex;
  }
}
