import { t } from '../i18n';
import { resolveHistoryBadgeLabel } from './activationHelpers';
import {
  recordHistoryMeasuredHeight,
  resolveHistoryViewportEntryHeight,
  resolveRepresentativeHistoryEntryHeight,
} from './historyMeasurements';
import {
  buildHistoryVirtualWindowKey,
  computeHistoryVisibleRange,
  computeHistoryVirtualWindow,
  HISTORY_VIRTUALIZE_AFTER,
  setHistoryScrollMode,
} from './historyViewport';
import { traceRenderedLensHistoryWindow } from './historyTrace';
import type { LensHistoryRequestSummary, LensHistorySnapshot } from '../../api/client';
import type {
  ArtifactClusterInfo,
  HistoryRenderPlan,
  HistoryScrollMetrics,
  HistoryViewportAnchor,
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
    provider: LensHistorySnapshot['provider'] | null | undefined,
  ) => void;
  createHistoryEntry: (
    entry: LensHistoryEntry,
    sessionId: string,
    options?: {
      artifactCluster?: ArtifactClusterInfo | null;
      showAssistantBadge?: boolean;
    },
  ) => HTMLElement;
  createHistorySpacer: (heightPx: number) => HTMLElement;
  createRequestActionBlock: (
    sessionId: string,
    request: LensHistoryRequestSummary,
    busy: boolean,
    state: SessionLensViewState,
    surface: 'composer' | 'history',
  ) => HTMLElement;
  pruneAssistantMarkdownCache: (
    state: SessionLensViewState,
    entries: readonly LensHistoryEntry[],
  ) => void;
  renderRuntimeStats: (panel: HTMLDivElement, stats: SessionLensViewState['runtimeStats']) => void;
};

export type HistoryWindowViewportMetrics = HistoryViewportMetrics & {
  historyWindowStart: number;
  historyWindowEnd: number;
  totalHistoryCount: number;
  offWindowTopSpacerPx: number;
  offWindowBottomSpacerPx: number;
};

function resolveAverageHistoryEntryHeight(
  entries: readonly LensHistoryEntry[],
  state: SessionLensViewState | undefined,
  resolveEntryHeight: (entry: LensHistoryEntry) => number,
): number {
  if ((state?.historyObservedHeights.size ?? 0) > 0) {
    return resolveRepresentativeHistoryEntryHeight(state?.historyObservedHeights.values() ?? []);
  }

  if (entries.length === 0) {
    return 72;
  }

  const totalHeight = entries.reduce((sum, entry) => sum + resolveEntryHeight(entry), 0);
  return Math.max(1, totalHeight / entries.length);
}

function estimateOffWindowSpacerPx(
  entries: readonly LensHistoryEntry[],
  state: SessionLensViewState | undefined,
  unseenItemCount: number,
  resolveEntryHeight: (entry: LensHistoryEntry) => number,
): number {
  if (unseenItemCount <= 0) {
    return 0;
  }

  const averageHeight = resolveAverageHistoryEntryHeight(entries, state, resolveEntryHeight);
  return Math.max(0, Math.round(averageHeight * unseenItemCount));
}

export function resolveHistoryWindowViewportMetrics(
  entries: readonly LensHistoryEntry[],
  state: SessionLensViewState | undefined,
  metrics: HistoryViewportMetrics,
  resolveEntryHeight: (entry: LensHistoryEntry) => number,
): HistoryWindowViewportMetrics {
  const historyWindowStart = Math.max(0, state?.snapshot?.historyWindowStart ?? 0);
  const historyWindowEnd = Math.max(historyWindowStart, state?.snapshot?.historyWindowEnd ?? 0);
  const totalHistoryCount = Math.max(historyWindowEnd, state?.snapshot?.historyCount ?? 0);
  const offWindowTopCount = historyWindowStart;
  const offWindowBottomCount = Math.max(0, totalHistoryCount - historyWindowEnd);
  const offWindowTopSpacerPx = estimateOffWindowSpacerPx(
    entries,
    state,
    offWindowTopCount,
    resolveEntryHeight,
  );
  const offWindowBottomSpacerPx = estimateOffWindowSpacerPx(
    entries,
    state,
    offWindowBottomCount,
    resolveEntryHeight,
  );

  return {
    ...metrics,
    scrollTop: Math.max(0, metrics.scrollTop - offWindowTopSpacerPx),
    historyWindowStart,
    historyWindowEnd,
    totalHistoryCount,
    offWindowTopSpacerPx,
    offWindowBottomSpacerPx,
  };
}

function syncViewportScrollPosition(viewport: HTMLDivElement, targetScrollTop: number): boolean {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const nextScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
  if (Math.abs(nextScrollTop - viewport.scrollTop) <= 1) {
    return false;
  }

  viewport.scrollTop = nextScrollTop;
  return Math.abs(viewport.scrollTop - nextScrollTop) <= 1;
}

function syncHistoryMeasurementObserver(args: {
  sessionId: string;
  state: SessionLensViewState;
  visibleEntries: readonly HistoryVisibleEntry[];
  getState: (sessionId: string) => SessionLensViewState | undefined;
  captureHistoryViewportAnchor: (
    state: SessionLensViewState,
    key?: 'pendingHistoryPrependAnchor' | 'pendingHistoryLayoutAnchor',
  ) => boolean;
  scheduleHistoryRender: (sessionId: string) => void;
}): void {
  if (typeof ResizeObserver !== 'function') {
    return;
  }

  args.state.historyMeasurementObserver ??= new ResizeObserver((records) => {
    const current = args.getState(args.sessionId);
    const viewport = current?.historyViewport;
    if (!current || !viewport) {
      return;
    }

    let changed = false;
    for (const record of records) {
      const target = record.target as HTMLElement;
      const entryId = target.dataset.lensEntryId;
      if (!entryId) {
        continue;
      }

      changed =
        recordHistoryMeasuredHeight(
          current,
          entryId,
          record.contentRect.height,
          viewport.clientWidth,
        ) || changed;
    }

    if (!changed) {
      return;
    }

    if (
      !current.historyAutoScrollPinned &&
      current.pendingHistoryPrependAnchor === null &&
      current.pendingHistoryLayoutAnchor === null
    ) {
      args.captureHistoryViewportAnchor(current, 'pendingHistoryLayoutAnchor');
    }

    args.scheduleHistoryRender(args.sessionId);
  });

  args.state.historyMeasurementObserver.disconnect();
  for (const visibleEntry of args.visibleEntries) {
    const node = args.state.historyRenderedNodes.get(visibleEntry.key)?.node;
    if (node) {
      args.state.historyMeasurementObserver.observe(node);
    }
  }
}

function buildVisibleHistoryEntries(args: {
  entries: readonly LensHistoryEntry[];
  visibleStart: number;
  visibleEnd: number;
  state: SessionLensViewState | undefined;
  resolveCluster: (
    entries: readonly LensHistoryEntry[],
    absoluteIndex: number,
  ) => ArtifactClusterInfo | null;
  buildSignature: (
    entry: LensHistoryEntry,
    cluster: ArtifactClusterInfo | null,
    state: SessionLensViewState | undefined,
    showAssistantBadge: boolean,
  ) => string;
}): HistoryVisibleEntry[] {
  const { entries, visibleStart, visibleEnd, state, resolveCluster, buildSignature } = args;
  return entries.slice(visibleStart, visibleEnd).map((entry, visibleIndex) => {
    const absoluteIndex = visibleStart + visibleIndex;
    const cluster = resolveCluster(entries, absoluteIndex);
    const showAssistantBadge = shouldShowAssistantBadge(entries, absoluteIndex);
    return {
      key: entry.id,
      entry,
      cluster,
      showAssistantBadge,
      signature: buildSignature(entry, cluster, state, showAssistantBadge),
    };
  });
}

function hasEarlierAssistantInTurn(
  entries: readonly LensHistoryEntry[],
  absoluteIndex: number,
  sourceTurnId: string,
): boolean {
  for (let index = absoluteIndex - 1; index >= 0; index -= 1) {
    const previous = entries[index];
    if (previous?.kind === 'assistant' && (previous.sourceTurnId?.trim() ?? '') === sourceTurnId) {
      return true;
    }
  }

  return false;
}

function didUserStartMostRecentUntaggedRun(
  entries: readonly LensHistoryEntry[],
  absoluteIndex: number,
): boolean {
  for (let index = absoluteIndex - 1; index >= 0; index -= 1) {
    const previous = entries[index];
    if (!previous) {
      continue;
    }

    if (previous.kind === 'assistant') {
      return false;
    }

    if (previous.kind === 'user') {
      return true;
    }
  }

  return true;
}

function shouldShowAssistantBadge(
  entries: readonly LensHistoryEntry[],
  absoluteIndex: number,
): boolean {
  const entry = entries[absoluteIndex];
  if (!entry || entry.kind !== 'assistant') {
    return false;
  }

  const sourceTurnId = entry.sourceTurnId?.trim() ?? '';
  return sourceTurnId
    ? !hasEarlierAssistantInTurn(entries, absoluteIndex, sourceTurnId)
    : didUserStartMostRecentUntaggedRun(entries, absoluteIndex);
}

function resolveAnchorAbsoluteIndex(state: SessionLensViewState, entryId: string): number {
  const relativeIndex = state.historyEntries.findIndex((entry) => entry.id === entryId);
  const historyWindowStart = state.snapshot?.historyWindowStart ?? 0;
  return relativeIndex >= 0 ? historyWindowStart + relativeIndex : historyWindowStart;
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

function buildAssistantPreviewToken(
  entry: LensHistoryEntry,
  state: SessionLensViewState | undefined,
): string {
  void state;
  return (entry.imagePreviews ?? []).map((preview) => preview.resolvedPath).join('|');
}

function buildHistoryActionToken(entry: LensHistoryEntry): string {
  return (entry.actions ?? [])
    .map((action) => [action.id, action.label, action.style, action.busyLabel ?? ''].join(':'))
    .join('|');
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
    const measurementChanged = state
      ? measureRenderedHistoryHeights(
          sessionId,
          state,
          renderPlan.visibleEntries,
          metrics.clientWidth,
        )
      : false;
    if (state?.snapshot) {
      traceRenderedLensHistoryWindow({
        sessionId,
        entries,
        metrics,
        state,
        resolveEntryHeight: (entry) =>
          resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth),
      });
    }
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
        deferVirtualization: false,
      };
    }

    const resolveEntryHeight = (entry: LensHistoryEntry) =>
      resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth);
    const windowMetrics = resolveHistoryWindowViewportMetrics(
      entries,
      state,
      metrics,
      resolveEntryHeight,
    );
    const virtualWindow = computeHistoryVirtualWindow(
      entries,
      windowMetrics.scrollTop,
      windowMetrics.clientHeight,
      windowMetrics.clientWidth,
      resolveEntryHeight,
    );
    const deferVirtualization = Boolean(
      state?.pendingHistoryPrependAnchor || state?.pendingHistoryLayoutAnchor,
    );
    const visibleStart = deferVirtualization ? 0 : virtualWindow.start;
    const visibleEnd = deferVirtualization ? entries.length : virtualWindow.end;

    return {
      emptyStateText: null,
      virtualWindowKey: deferVirtualization ? null : buildHistoryVirtualWindowKey(virtualWindow),
      topSpacerPx: deferVirtualization
        ? windowMetrics.offWindowTopSpacerPx
        : windowMetrics.offWindowTopSpacerPx + virtualWindow.topSpacerPx,
      bottomSpacerPx: deferVirtualization
        ? windowMetrics.offWindowBottomSpacerPx
        : windowMetrics.offWindowBottomSpacerPx + virtualWindow.bottomSpacerPx,
      visibleEntries: buildVisibleHistoryEntries({
        entries,
        visibleStart,
        visibleEnd,
        state,
        resolveCluster: resolveArtifactCluster,
        buildSignature: buildHistoryEntrySignature,
      }),
      deferVirtualization,
    };
  }

  function finalizeRenderedHistoryState(
    sessionId: string,
    panel: HTMLDivElement,
    viewport: HTMLDivElement,
    entries: readonly LensHistoryEntry[],
    state: SessionLensViewState | undefined,
    measurementChanged: boolean,
  ): void {
    let scrollAdjusted = false;
    if (state && !state.historyAutoScrollPinned) {
      scrollAdjusted =
        restorePendingHistoryAnchor(viewport, state, 'pendingHistoryPrependAnchor') ||
        restorePendingHistoryAnchor(viewport, state, 'pendingHistoryLayoutAnchor');
    }

    if (state?.historyAutoScrollPinned) {
      syncPinnedHistoryViewport(sessionId, panel, viewport, entries.length);
    } else if (state && scrollAdjusted) {
      state.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
      renderScrollToBottomControl(panel, state);
      if (entries.length > HISTORY_VIRTUALIZE_AFTER) {
        deps.scheduleHistoryRender(sessionId);
      }
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

    setHistoryScrollMode(current, 'follow');
    current.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
    renderScrollToBottomControl(panel, current);
  }

  function buildHistoryEntrySignature(
    entry: LensHistoryEntry,
    cluster: ArtifactClusterInfo | null,
    state: SessionLensViewState | undefined,
    showAssistantBadge: boolean,
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
      showAssistantBadge ? '1' : '0',
      entry.sourceItemType ?? '',
      entry.commandText ?? '',
      (entry.commandOutputTail ?? []).join('\n'),
      buildHistoryAttachmentToken(entry),
      buildAssistantPreviewToken(entry, state),
      buildHistoryActionToken(entry),
      buildHistoryClusterToken(cluster),
      resolveHistoryEntryBusyToken(entry, state),
      buildHistoryRequestToken(entry, state),
    ].join('||');
  }

  function resolveHistoryEntryBusyToken(
    entry: LensHistoryEntry,
    state: SessionLensViewState | undefined,
  ): string {
    return state?.activationActionBusy === true && (entry.actions?.length ?? 0) > 0
      ? 'busy'
      : 'idle';
  }

  function buildHistoryRequestToken(
    entry: LensHistoryEntry,
    state: SessionLensViewState | undefined,
  ): string {
    if (entry.kind !== 'request' || !entry.requestId) {
      return '';
    }

    const request = state?.snapshot?.requests.find(
      (candidate) => candidate.requestId === entry.requestId,
    );
    if (!request) {
      return 'missing';
    }

    return [
      request.kind,
      request.state,
      request.decision ?? '',
      request.detail ?? '',
      request.updatedAt,
      request.answers.map((answer) => `${answer.questionId}:${answer.answers.join(',')}`).join('|'),
    ].join('::');
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
      state.historyMeasurementObserver?.disconnect();
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
      existing.node.dataset.lensEntryId = visibleEntry.key;
      return existing.node;
    }

    const node = deps.createHistoryEntry(visibleEntry.entry, sessionId, {
      artifactCluster: visibleEntry.cluster,
      showAssistantBadge: visibleEntry.showAssistantBadge,
    });
    node.dataset.lensEntryId = visibleEntry.key;
    state.historyRenderedNodes.set(visibleEntry.key, {
      node,
      signature: visibleEntry.signature,
      entry: visibleEntry.entry,
      cluster: visibleEntry.cluster,
    });
    return node;
  }

  function measureRenderedHistoryHeights(
    sessionId: string,
    state: SessionLensViewState,
    visibleEntries: readonly HistoryVisibleEntry[],
    clientWidth: number,
  ): boolean {
    let changed = false;
    for (const visibleEntry of visibleEntries) {
      const rendered = state.historyRenderedNodes.get(visibleEntry.key);
      if (!rendered?.node || typeof rendered.node.getBoundingClientRect !== 'function') {
        continue;
      }

      changed =
        recordHistoryMeasuredHeight(
          state,
          visibleEntry.key,
          rendered.node.getBoundingClientRect().height,
          clientWidth,
        ) || changed;
    }

    syncHistoryMeasurementObserver({
      sessionId,
      state,
      visibleEntries,
      getState: deps.getState,
      captureHistoryViewportAnchor,
      scheduleHistoryRender: deps.scheduleHistoryRender,
    });
    return changed;
  }

  function restorePendingHistoryAnchor(
    viewport: HTMLDivElement,
    state: SessionLensViewState,
    key: 'pendingHistoryPrependAnchor' | 'pendingHistoryLayoutAnchor',
  ): boolean {
    const anchor = state[key];
    if (!anchor) {
      return false;
    }

    const anchorNode = state.historyRenderedNodes.get(anchor.entryId)?.node;
    if (!anchorNode || typeof anchorNode.getBoundingClientRect !== 'function') {
      return false;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const anchorRect = anchorNode.getBoundingClientRect();
    state[key] = null;
    setHistoryScrollMode(state, 'browse');
    return syncViewportScrollPosition(
      viewport,
      viewport.scrollTop + (anchorRect.top - viewportRect.top - anchor.topOffsetPx),
    );
  }

  function captureHistoryViewportAnchor(
    state: SessionLensViewState,
    key:
      | 'pendingHistoryPrependAnchor'
      | 'pendingHistoryLayoutAnchor' = 'pendingHistoryPrependAnchor',
  ): boolean {
    const viewport = state.historyViewport;
    if (!viewport) {
      state[key] = null;
      return false;
    }

    const viewportRect = viewport.getBoundingClientRect();
    let bestAnchor: HistoryViewportAnchor | null = null;
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
        bestAnchor = {
          entryId,
          topOffsetPx,
          absoluteIndex: resolveAnchorAbsoluteIndex(state, entryId),
        };
      }
    }

    state[key] = bestAnchor;
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
    requests: readonly LensHistoryRequestSummary[],
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
        'composer',
      ),
    );
  }

  function syncRequestInteractionState(
    state: SessionLensViewState,
    requests: readonly LensHistoryRequestSummary[],
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

  function scrollHistoryToBottom(sessionId: string, behavior: ScrollBehavior = 'auto'): void {
    const state = deps.getState(sessionId);
    const viewport = state?.historyViewport;
    if (!state || !viewport) {
      return;
    }

    setHistoryScrollMode(state, 'follow');
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
    const windowMetrics = resolveHistoryWindowViewportMetrics(
      state.historyEntries,
      state,
      metrics,
      (entry) => resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth),
    );
    const virtualWindow = computeHistoryVirtualWindow(
      state.historyEntries,
      windowMetrics.scrollTop,
      windowMetrics.clientHeight,
      windowMetrics.clientWidth,
      (entry) => resolveHistoryViewportEntryHeight(entry, state, windowMetrics.clientWidth),
    );
    return buildHistoryVirtualWindowKey(virtualWindow) !== state.historyLastVirtualWindowKey;
  }

  function getViewportCenteredHistoryWindowRequest(
    state: SessionLensViewState,
    options: {
      minimumMarginItems: number;
      maximumMarginItems: number;
      anchorAbsoluteIndex?: number | null;
    },
  ): { startIndex: number; count: number } | null {
    const viewport = state.historyViewport;
    const snapshot = state.snapshot;
    if (!viewport || !snapshot || state.historyEntries.length === 0) {
      return null;
    }

    const metrics = readHistoryViewportMetrics(viewport);
    const windowMetrics = resolveHistoryWindowViewportMetrics(
      state.historyEntries,
      state,
      metrics,
      (entry) => resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth),
    );
    const visibleRange = computeHistoryVisibleRange(
      state.historyEntries,
      windowMetrics.scrollTop,
      windowMetrics.clientHeight,
      windowMetrics.clientWidth,
      (entry) => resolveHistoryViewportEntryHeight(entry, state, windowMetrics.clientWidth),
    );
    const visibleCount = Math.max(1, visibleRange.end - visibleRange.start);
    const marginItems = Math.max(
      options.minimumMarginItems,
      Math.min(options.maximumMarginItems, visibleCount * 2),
    );
    const absoluteVisibleStart = snapshot.historyWindowStart + visibleRange.start;
    const absoluteVisibleEnd = snapshot.historyWindowStart + visibleRange.end;
    const safeStart = snapshot.historyWindowStart + marginItems;
    const safeEnd = snapshot.historyWindowEnd - marginItems;
    const needsShift =
      absoluteVisibleStart < safeStart ||
      absoluteVisibleEnd > safeEnd ||
      snapshot.historyWindowEnd - snapshot.historyWindowStart > visibleCount + marginItems * 2;
    if (!needsShift) {
      return null;
    }

    const desiredStart = Math.max(0, absoluteVisibleStart - marginItems);
    const desiredEnd = Math.min(snapshot.historyCount, absoluteVisibleEnd + marginItems);
    const anchorAbsoluteIndex =
      typeof options.anchorAbsoluteIndex === 'number' &&
      Number.isFinite(options.anchorAbsoluteIndex)
        ? Math.max(0, Math.min(snapshot.historyCount - 1, options.anchorAbsoluteIndex))
        : null;
    const anchoredStart =
      anchorAbsoluteIndex === null ? desiredStart : Math.min(desiredStart, anchorAbsoluteIndex);
    const anchoredEnd =
      anchorAbsoluteIndex === null ? desiredEnd : Math.max(desiredEnd, anchorAbsoluteIndex + 1);
    const desiredCount = Math.max(1, anchoredEnd - anchoredStart);
    const maxStart = Math.max(0, snapshot.historyCount - desiredCount);
    const startIndex = Math.max(0, Math.min(anchoredStart, maxStart));
    const count = Math.min(snapshot.historyCount - startIndex, desiredCount);
    if (
      startIndex === snapshot.historyWindowStart &&
      count === snapshot.historyWindowEnd - snapshot.historyWindowStart
    ) {
      return null;
    }

    return { startIndex, count };
  }

  return {
    captureHistoryViewportAnchor,
    getViewportCenteredHistoryWindowRequest,
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
  requests: readonly LensHistoryRequestSummary[],
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
  requests: readonly LensHistoryRequestSummary[],
): LensHistoryRequestSummary | null {
  const openRequests = requests.filter(
    (request) => request.state === 'open' && request.kind !== 'interview',
  );
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
