import { t } from '../i18n';
import { resolveHistoryBadgeLabel } from './activationHelpers';
import {
  resolveHistoryEstimatedEntryHeight,
  recordHistoryMeasuredHeight,
  resolveHistoryViewportEntryHeight,
} from './historyMeasurements';
import {
  buildHistoryVirtualWindowKey,
  computeHistoryVirtualWindow,
  computeHistoryVisibleRange,
  HISTORY_VIRTUALIZE_AFTER,
  LENS_HISTORY_OVERSCAN_ITEMS,
  setHistoryScrollMode,
} from './historyViewport';
import { traceRenderedLensHistoryWindow } from './historyTrace';
import type { LensHistoryRequestSummary, LensHistorySnapshot } from '../../api/client';
import {
  captureViewportAnchor,
  resolveRetainedWindowViewportMetrics,
  resolveScrollCompensationDelta,
  resolveViewportCenteredWindowRequest,
  restoreViewportAnchor,
  syncViewportScrollPosition,
  type VirtualizerAnchor,
  type VirtualizerMeasuredItemChange,
  type VirtualizerWindowViewportMetrics,
} from '../../utils/virtualizer';
import type {
  ArtifactClusterInfo,
  HistoryPlaceholderBlock,
  HistoryRenderPlan,
  HistoryScrollMetrics,
  HistoryVirtualWindow,
  HistoryViewportMetrics,
  HistoryVisibleEntry,
  LensHistoryEntry,
  LensVirtualizerDebugState,
  LensVirtualizerVisibleRange,
  SessionLensViewState,
} from './types';
/* eslint-disable max-lines -- Lens history rendering/virtualization remains intentionally consolidated while the browser-side virtualizer is being hardened. */

function lensText(key: string, fallback: string): string {
  const translated = t(key);
  return !translated || translated === key ? fallback : translated;
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
  syncBusyIndicatorEntry?: (node: HTMLElement, entry: LensHistoryEntry) => void;
  createHistorySpacer: (heightPx: number) => HTMLElement;
  createHistoryPlaceholderBlock?: (args: {
    heightPx: number;
    itemCount: number;
    direction: 'earlier' | 'later';
    label: string;
    rangeLabel: string;
  }) => HTMLElement;
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
  renderVirtualizerDebug?: (panel: HTMLDivElement, state: SessionLensViewState | undefined) => void;
  syncViewportHistoryWindow?: (sessionId: string) => void;
};

const HISTORY_PLACEHOLDER_TARGET_BLOCK_HEIGHT_PX = 960;
const HISTORY_PLACEHOLDER_MAX_BLOCKS = 10;

export type HistoryWindowViewportMetrics = VirtualizerWindowViewportMetrics;

export function resolveHistoryWindowViewportMetrics(
  entries: readonly LensHistoryEntry[],
  state: SessionLensViewState | undefined,
  metrics: HistoryViewportMetrics,
  resolveEntryHeight: (entry: LensHistoryEntry) => number,
): HistoryWindowViewportMetrics {
  const historyWindowStart = Math.max(0, state?.snapshot?.historyWindowStart ?? 0);
  const historyWindowEnd = Math.max(historyWindowStart, state?.snapshot?.historyWindowEnd ?? 0);
  return resolveRetainedWindowViewportMetrics({
    items: entries,
    viewportMetrics: metrics,
    retainedWindow: {
      windowStart: historyWindowStart,
      windowEnd: historyWindowEnd,
      totalCount: Math.max(historyWindowEnd, state?.snapshot?.historyCount ?? 0),
    },
    observedSizes: state?.historyObservedHeights.values(),
    resolveItemSize: (entry) => resolveEntryHeight(entry),
    resolveEstimatedItemSize: (entry) =>
      resolveHistoryEstimatedEntryHeight(entry, metrics.clientWidth),
  });
}

function toHistoryViewportAnchor(
  anchor: VirtualizerAnchor | null,
): SessionLensViewState['pendingHistoryLayoutAnchor'] {
  if (!anchor) {
    return null;
  }

  return {
    entryId: anchor.key,
    topOffsetPx: anchor.topOffsetPx,
    absoluteIndex: anchor.absoluteIndex,
  };
}

function updateBusyIndicatorElapsedInState(
  state: SessionLensViewState | undefined,
  elapsedText: string,
): boolean {
  if (!state) {
    return false;
  }

  for (const rendered of state.historyRenderedNodes.values()) {
    if (!rendered.entry.busyIndicator) {
      continue;
    }

    const elapsed = rendered.node.querySelector<HTMLElement>('.agent-history-busy-elapsed');
    if (!elapsed) {
      return false;
    }

    elapsed.textContent = elapsedText;
    rendered.entry.busyElapsedText = elapsedText;
    return true;
  }

  return false;
}

function resolveMeasurementBrowseAnchor(
  state: SessionLensViewState,
  viewport: HTMLDivElement,
): VirtualizerAnchor | null {
  if (state.historyAutoScrollPinned || state.pendingHistoryPrependAnchor !== null) {
    return null;
  }

  return captureViewportAnchor({
    viewport,
    renderedNodes: Array.from(state.historyRenderedNodes, ([entryId, rendered]) => ({
      key: entryId,
      node: rendered.node,
      absoluteIndex: resolveAnchorAbsoluteIndex(state, entryId),
    })),
  });
}

function collectHistoryMeasurementChanges(args: {
  state: SessionLensViewState;
  viewport: HTMLDivElement;
  records: readonly ResizeObserverEntry[];
}): VirtualizerMeasuredItemChange[] {
  const { state, viewport, records } = args;
  const changes: VirtualizerMeasuredItemChange[] = [];

  for (const record of records) {
    const target = record.target as HTMLElement;
    const entryId = target.dataset.lensEntryId;
    if (!entryId) {
      continue;
    }

    const relativeIndex = state.historyEntries.findIndex((entry) => entry.id === entryId);
    const entry = relativeIndex >= 0 ? (state.historyEntries[relativeIndex] ?? null) : null;
    const previousSize =
      entry === null ? null : resolveHistoryViewportEntryHeight(entry, state, viewport.clientWidth);
    const sizeChanged = recordHistoryMeasuredHeight(
      state,
      entryId,
      record.contentRect.height,
      viewport.clientWidth,
    );
    if (!sizeChanged || entry === null || previousSize === null) {
      continue;
    }

    const nextSize = resolveHistoryViewportEntryHeight(entry, state, viewport.clientWidth);
    changes.push({
      absoluteIndex: (state.snapshot?.historyWindowStart ?? 0) + relativeIndex,
      previousSize,
      nextSize,
    });
    const rendered = state.historyRenderedNodes.get(entryId);
    if (rendered) {
      rendered.lastMeasuredWidthBucket = state.historyMeasuredWidthBucket;
    }
  }

  return changes;
}

function syncHistoryMeasurementObserver(args: {
  sessionId: string;
  state: SessionLensViewState;
  visibleEntries: readonly HistoryVisibleEntry[];
  getState: (sessionId: string) => SessionLensViewState | undefined;
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

    const browseAnchor = resolveMeasurementBrowseAnchor(current, viewport);
    const measurementChanges = collectHistoryMeasurementChanges({
      state: current,
      viewport,
      records,
    });
    if (measurementChanges.length === 0) {
      return;
    }

    const compensationDelta = resolveScrollCompensationDelta({
      changes: measurementChanges,
      anchorAbsoluteIndex: browseAnchor?.absoluteIndex,
    });
    if (!current.historyAutoScrollPinned && compensationDelta !== 0) {
      syncViewportScrollPosition(viewport, viewport.scrollTop + compensationDelta);
      current.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
    }

    if (!current.historyAutoScrollPinned && current.pendingHistoryPrependAnchor === null) {
      current.pendingHistoryLayoutAnchor = toHistoryViewportAnchor(browseAnchor);
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

function hasIntersectingRenderedHistoryEntry(
  viewport: HTMLDivElement,
  state: SessionLensViewState,
): boolean {
  if (typeof viewport.getBoundingClientRect !== 'function') {
    return true;
  }

  const viewportRect = viewport.getBoundingClientRect();
  for (const rendered of state.historyRenderedNodes.values()) {
    if (typeof rendered.node.getBoundingClientRect !== 'function') {
      continue;
    }

    const rect = rendered.node.getBoundingClientRect();
    const offsetTopPx = rect.top - viewportRect.top;
    const offsetBottomPx = rect.bottom - viewportRect.top;
    if (offsetBottomPx >= 0 && offsetTopPx <= viewport.clientHeight) {
      return true;
    }
  }

  return false;
}

function recoverViewportFromRenderedHistoryGap(
  viewport: HTMLDivElement,
  state: SessionLensViewState,
): boolean {
  if (typeof viewport.getBoundingClientRect !== 'function') {
    return false;
  }

  const viewportRect = viewport.getBoundingClientRect();
  let nearestOffsetTopPx: number | null = null;
  let nearestDistancePx: number | null = null;
  for (const rendered of state.historyRenderedNodes.values()) {
    if (typeof rendered.node.getBoundingClientRect !== 'function') {
      continue;
    }

    const rect = rendered.node.getBoundingClientRect();
    const offsetTopPx = rect.top - viewportRect.top;
    const offsetBottomPx = rect.bottom - viewportRect.top;
    if (offsetBottomPx >= 0 && offsetTopPx <= viewport.clientHeight) {
      return false;
    }

    const distancePx =
      offsetTopPx > viewport.clientHeight
        ? offsetTopPx - viewport.clientHeight
        : Math.max(0, -offsetBottomPx);
    if (nearestDistancePx === null || distancePx < nearestDistancePx) {
      nearestDistancePx = distancePx;
      nearestOffsetTopPx = offsetTopPx;
    }
  }

  if (nearestOffsetTopPx === null) {
    return false;
  }

  return syncViewportScrollPosition(viewport, viewport.scrollTop + nearestOffsetTopPx - 24);
}

function sumHistoryEntryHeights(
  entries: readonly LensHistoryEntry[],
  start: number,
  end: number,
  resolveEntryHeight: (entry: LensHistoryEntry) => number,
): number {
  let total = 0;
  for (let index = Math.max(0, start); index < Math.min(entries.length, end); index += 1) {
    const entry = entries[index];
    if (entry) {
      total += resolveEntryHeight(entry);
    }
  }

  return total;
}

function createFallbackHistoryPlaceholderBlock(args: {
  heightPx: number;
  itemCount: number;
  direction: 'earlier' | 'later';
  label: string;
  rangeLabel: string;
}): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'agent-history-placeholder';
  block.dataset.direction = args.direction;
  block.style.height = `${Math.max(0, Math.round(args.heightPx))}px`;
  return block;
}

function formatHistoryPlaceholderRange(startIndex: number, endIndex: number): string {
  const start = startIndex + 1;
  const end = endIndex;
  if (end <= start) {
    return `${Math.max(1, start)}`;
  }

  return `${Math.max(1, start)}-${Math.max(start, end)}`;
}

function buildHistoryPlaceholderBlocks(args: {
  keyPrefix: string;
  heightPx: number;
  itemCount: number;
  direction: 'earlier' | 'later';
  label: string;
  absoluteStart: number;
}): HistoryPlaceholderBlock[] {
  const roundedHeightPx = Math.max(0, Math.round(args.heightPx));
  if (roundedHeightPx <= 0 || args.itemCount <= 0) {
    return [];
  }

  const blockCount = Math.max(
    1,
    Math.min(
      HISTORY_PLACEHOLDER_MAX_BLOCKS,
      Math.ceil(roundedHeightPx / HISTORY_PLACEHOLDER_TARGET_BLOCK_HEIGHT_PX),
      args.itemCount,
    ),
  );
  const blocks: HistoryPlaceholderBlock[] = [];
  let remainingHeightPx = roundedHeightPx;
  let remainingItemCount = args.itemCount;
  let nextAbsoluteIndex = args.absoluteStart;

  for (let index = 0; index < blockCount; index += 1) {
    const slotsLeft = blockCount - index;
    const blockItemCount = Math.max(1, Math.round(remainingItemCount / slotsLeft));
    const blockHeightPx =
      index === blockCount - 1
        ? remainingHeightPx
        : Math.max(blockItemCount, Math.round(remainingHeightPx / slotsLeft));
    const nextAbsoluteEnd = Math.min(
      args.absoluteStart + args.itemCount,
      nextAbsoluteIndex + blockItemCount,
    );
    blocks.push({
      key: `${args.keyPrefix}-${index}`,
      heightPx: blockHeightPx,
      itemCount: blockItemCount,
      direction: args.direction,
      label: args.label,
      rangeLabel: formatHistoryPlaceholderRange(nextAbsoluteIndex, nextAbsoluteEnd),
    });
    remainingHeightPx = Math.max(0, remainingHeightPx - blockHeightPx);
    remainingItemCount = Math.max(0, remainingItemCount - blockItemCount);
    nextAbsoluteIndex = nextAbsoluteEnd;
  }

  return blocks;
}

function expandHistoryVirtualWindowForPendingAnchor(args: {
  entries: readonly LensHistoryEntry[];
  virtualWindow: HistoryVirtualWindow;
  state?: SessionLensViewState | undefined;
  resolveEntryHeight: (entry: LensHistoryEntry) => number;
}): HistoryVirtualWindow {
  const { entries, virtualWindow, state, resolveEntryHeight } = args;
  const anchorEntryId =
    state?.pendingHistoryPrependAnchor?.entryId ?? state?.pendingHistoryLayoutAnchor?.entryId;
  if (!anchorEntryId) {
    return virtualWindow;
  }

  const anchorIndex = entries.findIndex((entry) => entry.id === anchorEntryId);
  if (anchorIndex < 0) {
    return virtualWindow;
  }

  const corridorStart = Math.max(0, anchorIndex - LENS_HISTORY_OVERSCAN_ITEMS);
  const corridorEnd = Math.min(entries.length, anchorIndex + LENS_HISTORY_OVERSCAN_ITEMS + 1);
  const start = Math.min(virtualWindow.start, corridorStart);
  const end = Math.max(virtualWindow.end, corridorEnd);
  if (start === virtualWindow.start && end === virtualWindow.end) {
    return virtualWindow;
  }

  const extraTopHeight = sumHistoryEntryHeights(
    entries,
    start,
    virtualWindow.start,
    resolveEntryHeight,
  );
  const extraBottomHeight = sumHistoryEntryHeights(
    entries,
    virtualWindow.end,
    end,
    resolveEntryHeight,
  );

  return {
    start,
    end,
    topSpacerPx: Math.max(0, virtualWindow.topSpacerPx - extraTopHeight),
    bottomSpacerPx: Math.max(0, virtualWindow.bottomSpacerPx - extraBottomHeight),
  };
}

/* eslint-disable max-lines-per-function, complexity -- Lens history render orchestration is intentionally centralized while the virtualizer contract is still moving. */
export function createAgentHistoryRender(deps: HistoryRenderDeps) {
  function isVirtualizedHistoryContext(
    state: SessionLensViewState | undefined,
    entryCount: number,
  ): boolean {
    if (!state) {
      return entryCount > HISTORY_VIRTUALIZE_AFTER;
    }

    const snapshot = state.snapshot;
    const historyCount = snapshot?.historyCount ?? entryCount;
    if (historyCount > HISTORY_VIRTUALIZE_AFTER) {
      return true;
    }

    if (
      state.historyLeadingPlaceholders.length > 0 ||
      state.historyTrailingPlaceholders.length > 0
    ) {
      return true;
    }

    if (!snapshot) {
      return false;
    }

    return snapshot.historyWindowStart > 0 || snapshot.historyWindowEnd < snapshot.historyCount;
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
    updateVirtualizerDebugState(state, renderPlan, metrics);
    deps.renderVirtualizerDebug?.(panel, state);
  }

  function resolveVisibleRangeDebugState(
    state: SessionLensViewState,
    renderPlan: HistoryRenderPlan,
  ): LensVirtualizerVisibleRange {
    const firstVisible = renderPlan.visibleEntries[0];
    const lastVisible = renderPlan.visibleEntries[renderPlan.visibleEntries.length - 1];
    if (!state.snapshot || !firstVisible || !lastVisible) {
      return {
        absoluteStart: null,
        absoluteEnd: null,
        startId: null,
        endId: null,
      };
    }

    const firstRelativeIndex = state.historyEntries.findIndex(
      (entry) => entry.id === firstVisible.key,
    );
    const lastRelativeIndex = state.historyEntries.findIndex(
      (entry) => entry.id === lastVisible.key,
    );
    if (firstRelativeIndex < 0 || lastRelativeIndex < 0) {
      return {
        absoluteStart: null,
        absoluteEnd: null,
        startId: null,
        endId: null,
      };
    }

    return {
      absoluteStart: state.snapshot.historyWindowStart + firstRelativeIndex,
      absoluteEnd: state.snapshot.historyWindowStart + lastRelativeIndex,
      startId: firstVisible.key,
      endId: lastVisible.key,
    };
  }

  function updateVirtualizerDebugState(
    state: SessionLensViewState | undefined,
    renderPlan: HistoryRenderPlan,
    metrics: HistoryViewportMetrics,
  ): void {
    if (!state) {
      return;
    }

    const debugState = ensureVirtualizerDebugState(state);
    debugState.placeholderCount =
      renderPlan.leadingPlaceholders.length + renderPlan.trailingPlaceholders.length;
    const visibleRange = computeHistoryVisibleRange(
      state.historyEntries,
      metrics.scrollTop,
      metrics.clientHeight,
      metrics.clientWidth,
      (entry) => resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth),
    );
    debugState.visibleRange = resolveVisibleRangeDebugState(state, {
      ...renderPlan,
      visibleEntries: buildVisibleHistoryEntries({
        entries: state.historyEntries,
        visibleStart: visibleRange.start,
        visibleEnd: visibleRange.end,
        state,
        resolveCluster: resolveArtifactCluster,
        buildSignature: buildHistoryEntrySignature,
      }),
    });
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
        leadingPlaceholders: [],
        trailingPlaceholders: [],
        visibleEntries: [],
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
    const renderedWindow = expandHistoryVirtualWindowForPendingAnchor({
      entries,
      virtualWindow,
      state,
      resolveEntryHeight,
    });
    const retainedWindowStart = windowMetrics.retainedWindowStart;
    const retainedWindowEnd = windowMetrics.retainedWindowEnd;
    const leadingPlaceholders = [
      ...buildHistoryPlaceholderBlocks({
        keyPrefix: 'history-off-window-earlier',
        heightPx: windowMetrics.effectiveOffWindowTopSpacerPx,
        itemCount: retainedWindowStart,
        direction: 'earlier',
        label: lensText('lens.history.placeholderEarlier', 'Earlier history'),
        absoluteStart: 0,
      }),
      ...buildHistoryPlaceholderBlocks({
        keyPrefix: 'history-retained-earlier',
        heightPx: renderedWindow.topSpacerPx,
        itemCount: renderedWindow.start,
        direction: 'earlier',
        label: lensText('lens.history.placeholderNearbyEarlier', 'Buffered earlier rows'),
        absoluteStart: retainedWindowStart,
      }),
    ];
    const trailingPlaceholders = [
      ...buildHistoryPlaceholderBlocks({
        keyPrefix: 'history-retained-later',
        heightPx: renderedWindow.bottomSpacerPx,
        itemCount: Math.max(0, entries.length - renderedWindow.end),
        direction: 'later',
        label: lensText('lens.history.placeholderNearbyLater', 'Buffered later rows'),
        absoluteStart: retainedWindowStart + renderedWindow.end,
      }),
      ...buildHistoryPlaceholderBlocks({
        keyPrefix: 'history-off-window-later',
        heightPx: windowMetrics.offWindowBottomSpacerPx,
        itemCount: Math.max(0, windowMetrics.totalCount - retainedWindowEnd),
        direction: 'later',
        label: lensText('lens.history.placeholderLater', 'Later history'),
        absoluteStart: retainedWindowEnd,
      }),
    ];

    return {
      emptyStateText: null,
      virtualWindowKey: buildHistoryVirtualWindowKey(renderedWindow),
      leadingPlaceholders,
      trailingPlaceholders,
      visibleEntries: buildVisibleHistoryEntries({
        entries,
        visibleStart: renderedWindow.start,
        visibleEnd: renderedWindow.end,
        state,
        resolveCluster: resolveArtifactCluster,
        buildSignature: buildHistoryEntrySignature,
      }),
    };
  }

  function adjustBrowseViewportIfNeeded(
    viewport: HTMLDivElement,
    state: SessionLensViewState | undefined,
  ): boolean {
    if (!state || state.historyAutoScrollPinned) {
      return false;
    }

    const restoredAnchor =
      restorePendingHistoryAnchor(viewport, state, 'pendingHistoryPrependAnchor') ||
      restorePendingHistoryAnchor(viewport, state, 'pendingHistoryLayoutAnchor');
    if (restoredAnchor) {
      return true;
    }

    const leadingPlaceholders = state.historyLeadingPlaceholders;
    const trailingPlaceholders = state.historyTrailingPlaceholders;
    if (leadingPlaceholders.length === 0 && trailingPlaceholders.length === 0) {
      return false;
    }

    if (state.historyRenderedNodes.size === 0) {
      return false;
    }

    if (hasIntersectingRenderedHistoryEntry(viewport, state)) {
      return false;
    }

    return recoverViewportFromRenderedHistoryGap(viewport, state);
  }

  function finalizeRenderedHistoryState(
    sessionId: string,
    panel: HTMLDivElement,
    viewport: HTMLDivElement,
    entries: readonly LensHistoryEntry[],
    state: SessionLensViewState | undefined,
    measurementChanged: boolean,
  ): void {
    const browseViewportAdjusted = adjustBrowseViewportIfNeeded(viewport, state);
    const hasPlaceholderRanges =
      state !== undefined &&
      (state.historyLeadingPlaceholders.length > 0 || state.historyTrailingPlaceholders.length > 0);
    const viewportHasConcreteRows =
      !state || !hasPlaceholderRanges ? true : hasIntersectingRenderedHistoryEntry(viewport, state);

    if (state?.historyAutoScrollPinned) {
      state.historyLastVoidSyncScrollTop = null;
      syncPinnedHistoryViewport(sessionId, panel, viewport, entries.length);
    } else if (state && browseViewportAdjusted) {
      state.historyLastVoidSyncScrollTop = null;
      state.historyLastScrollMetrics = readHistoryScrollMetrics(viewport);
      renderScrollToBottomControl(panel, state);
      if (isVirtualizedHistoryContext(state, entries.length)) {
        deps.scheduleHistoryRender(sessionId);
      }
    }

    if (state && viewportHasConcreteRows) {
      state.historyLastVoidSyncScrollTop = null;
    }

    if (state && !state.historyAutoScrollPinned && entries.length > 0 && !viewportHasConcreteRows) {
      const roundedScrollTop = Math.round(viewport.scrollTop);
      if (state.historyLastVoidSyncScrollTop !== roundedScrollTop) {
        state.historyLastVoidSyncScrollTop = roundedScrollTop;
        deps.syncViewportHistoryWindow?.(sessionId);
      }
    }

    if (measurementChanged && isVirtualizedHistoryContext(state, entries.length)) {
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
    const current = deps.getState(sessionId);
    if (didAutoScroll && isVirtualizedHistoryContext(current, entryCount)) {
      deps.scheduleHistoryRender(sessionId);
    }

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
      state.historyLeadingPlaceholders = [];
      state.historyTrailingPlaceholders = [];
      return;
    }

    state.historyEmptyState = null;
    const nextChildren: HTMLElement[] = [];
    nextChildren.push(
      ...resolveHistoryPlaceholderNodes(state, 'leading', plan.leadingPlaceholders),
    );

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

    nextChildren.push(
      ...resolveHistoryPlaceholderNodes(state, 'trailing', plan.trailingPlaceholders),
    );

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

  function ensureHistoryPlaceholderNode(
    state: SessionLensViewState,
    position: 'leading' | 'trailing',
    blockIndex: number,
    block: HistoryPlaceholderBlock,
  ): HTMLDivElement {
    const store =
      position === 'leading' ? state.historyLeadingPlaceholders : state.historyTrailingPlaceholders;
    const existing = store[blockIndex];
    const placeholderFactory =
      deps.createHistoryPlaceholderBlock ?? createFallbackHistoryPlaceholderBlock;
    const node =
      existing ??
      (placeholderFactory({
        heightPx: block.heightPx,
        itemCount: block.itemCount,
        direction: block.direction,
        label: block.label,
        rangeLabel: block.rangeLabel,
      }) as HTMLDivElement);
    node.className = 'agent-history-placeholder';
    node.dataset.direction = block.direction;
    node.dataset.placeholderKey = block.key;
    node.style.height = `${Math.max(0, Math.round(block.heightPx))}px`;
    const selectorRoot = node as unknown as Record<string, unknown>;
    if (typeof selectorRoot['querySelector'] !== 'function') {
      store[blockIndex] = node;
      return node;
    }

    // Existing placeholder nodes are reused, so refresh their visible labels.
    const title = node.querySelector<HTMLElement>('.agent-history-placeholder-title');
    if (title) {
      title.textContent = block.label;
    }

    const meta = node.querySelector<HTMLElement>('.agent-history-placeholder-meta');
    if (meta) {
      meta.textContent = `${block.itemCount} items${block.rangeLabel ? ` • ${block.rangeLabel}` : ''}`;
    }
    node.setAttribute(
      'aria-label',
      `${block.label}: ${block.itemCount} items represented by an estimated placeholder block`,
    );
    store[blockIndex] = node;
    return node;
  }

  function resolveHistoryPlaceholderNodes(
    state: SessionLensViewState,
    position: 'leading' | 'trailing',
    blocks: readonly HistoryPlaceholderBlock[],
  ): HTMLDivElement[] {
    const store =
      position === 'leading' ? state.historyLeadingPlaceholders : state.historyTrailingPlaceholders;
    const nodes = blocks.map((block, index) =>
      ensureHistoryPlaceholderNode(state, position, index, block),
    );
    store.length = blocks.length;
    return nodes;
  }

  function resolveRenderedHistoryNode(
    sessionId: string,
    state: SessionLensViewState,
    visibleEntry: HistoryVisibleEntry,
  ): HTMLElement {
    const existing = state.historyRenderedNodes.get(visibleEntry.key);
    if (existing && existing.entry.busyIndicator && visibleEntry.entry.busyIndicator) {
      deps.syncBusyIndicatorEntry?.(existing.node, visibleEntry.entry);
      existing.node.dataset.lensEntryId = visibleEntry.key;
      existing.signature = visibleEntry.signature;
      existing.entry = visibleEntry.entry;
      existing.cluster = visibleEntry.cluster;
      existing.lastMeasuredWidthBucket = null;
      return existing.node;
    }

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
      lastMeasuredWidthBucket: null,
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
    const widthBucket = state.historyMeasuredWidthBucket;
    for (const visibleEntry of visibleEntries) {
      const rendered = state.historyRenderedNodes.get(visibleEntry.key);
      if (!rendered?.node || typeof rendered.node.getBoundingClientRect !== 'function') {
        continue;
      }

      if (rendered.lastMeasuredWidthBucket === widthBucket) {
        continue;
      }

      changed =
        recordHistoryMeasuredHeight(
          state,
          visibleEntry.key,
          rendered.node.getBoundingClientRect().height,
          clientWidth,
        ) || changed;
      rendered.lastMeasuredWidthBucket = state.historyMeasuredWidthBucket;
    }

    syncHistoryMeasurementObserver({
      sessionId,
      state,
      visibleEntries,
      getState: deps.getState,
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

    state[key] = null;
    setHistoryScrollMode(state, 'browse');
    return restoreViewportAnchor({
      viewport,
      anchor: {
        key: anchor.entryId,
        topOffsetPx: anchor.topOffsetPx,
        absoluteIndex: anchor.absoluteIndex,
      },
      resolveNode: (entryId) => state.historyRenderedNodes.get(entryId)?.node,
    });
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

    const anchor = captureViewportAnchor({
      viewport,
      renderedNodes: Array.from(state.historyRenderedNodes, ([entryId, rendered]) => ({
        key: entryId,
        node: rendered.node,
        absoluteIndex: resolveAnchorAbsoluteIndex(state, entryId),
      })),
    });
    state[key] = anchor
      ? {
          entryId: anchor.key,
          topOffsetPx: anchor.topOffsetPx,
          absoluteIndex: anchor.absoluteIndex,
        }
      : null;
    return anchor !== null;
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
    if (!viewport || !isVirtualizedHistoryContext(state, state.historyEntries.length)) {
      return false;
    }

    if (
      state.historyRenderedNodes.size > 0 &&
      (state.historyLeadingPlaceholders.length > 0 ||
        state.historyTrailingPlaceholders.length > 0) &&
      !hasIntersectingRenderedHistoryEntry(viewport, state)
    ) {
      return true;
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
      fetchAheadItems: number;
      anchorAbsoluteIndex?: number | null;
    },
  ): { startIndex: number; count: number } | null {
    const viewport = state.historyViewport;
    const snapshot = state.snapshot;
    if (!viewport || !snapshot || state.historyEntries.length === 0) {
      return null;
    }

    const metrics = readHistoryViewportMetrics(viewport);
    const resolveEntryHeight = (entry: LensHistoryEntry) =>
      resolveHistoryViewportEntryHeight(entry, state, metrics.clientWidth);
    const request = resolveViewportCenteredWindowRequest({
      items: state.historyEntries,
      viewportMetrics: metrics,
      retainedWindow: {
        windowStart: snapshot.historyWindowStart,
        windowEnd: snapshot.historyWindowEnd,
        totalCount: snapshot.historyCount,
      },
      fetchAheadItems: options.fetchAheadItems,
      resolveItemSize: (entry) => resolveEntryHeight(entry),
      observedSizes: state.historyObservedHeights.values(),
      anchorAbsoluteIndex: options.anchorAbsoluteIndex,
      resolveEstimatedItemSize: (entry) =>
        resolveHistoryEstimatedEntryHeight(entry, metrics.clientWidth),
    });
    return request;
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
    updateBusyIndicatorElapsed: (sessionId: string, elapsedText: string) =>
      updateBusyIndicatorElapsedInState(deps.getState(sessionId), elapsedText),
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
/* eslint-enable max-lines-per-function, complexity */
/* eslint-enable max-lines */
