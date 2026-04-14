import { estimateHistoryEntryHeight } from './historyContent';
import type {
  HistoryIndexRange,
  HistoryScrollMetrics,
  HistoryScrollMode,
  HistoryVirtualWindow,
  LensHistoryEntry,
  SessionLensViewState,
} from './types';

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const HISTORY_OVERSCAN_PX = 800;
export const HISTORY_VIRTUALIZE_AFTER = 50;

type HistoryHeightResolver = (entry: LensHistoryEntry, index: number) => number;

interface HistoryLayoutModel {
  prefixHeights: number[];
  totalHeight: number;
}

export function stabilizeHistoryEntryOrder(
  entries: readonly LensHistoryEntry[],
): LensHistoryEntry[] {
  return [...entries].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

/**
 * Protects the user's reading position during streaming turns so Lens only
 * auto-pins when they are effectively already following the live edge.
 */
export function isScrollContainerNearBottom(position: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean {
  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }

  return scrollHeight - clientHeight - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
}

export function resolveHistoryScrollMode(args: {
  previousMode: HistoryScrollMode;
  previous: HistoryScrollMetrics | null;
  current: HistoryScrollMetrics;
  userInitiated: boolean;
  pendingAnchorRestore: boolean;
}): HistoryScrollMode {
  if (args.pendingAnchorRestore) {
    return 'restore-anchor';
  }

  const nearBottom = isScrollContainerNearBottom(args.current);
  const userScrolledUp =
    args.previous !== null &&
    Number.isFinite(args.previous.scrollTop) &&
    Number.isFinite(args.current.scrollTop) &&
    args.current.scrollTop < args.previous.scrollTop - 1;

  if (args.userInitiated) {
    if (userScrolledUp) {
      return 'browse';
    }

    return nearBottom ? 'follow' : 'browse';
  }

  if (args.previousMode === 'follow' && userScrolledUp && !nearBottom) {
    return 'browse';
  }

  if (args.previousMode === 'follow') {
    return 'follow';
  }

  return nearBottom ? 'follow' : 'browse';
}

export function isHistoryScrollModePinned(mode: HistoryScrollMode): boolean {
  return mode === 'follow';
}

export function setHistoryScrollMode(
  state: SessionLensViewState,
  mode: HistoryScrollMode,
): HistoryScrollMode {
  state.historyScrollMode = mode;
  state.historyAutoScrollPinned = isHistoryScrollModePinned(mode);
  return mode;
}

/**
 * Virtualizes long histories across viewport sizes so Lens keeps a bounded
 * DOM even during extended agent runs.
 */
export function computeHistoryVirtualWindow(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth = typeof window === 'undefined' ? 960 : window.innerWidth,
  resolveEntryHeight?: HistoryHeightResolver,
): HistoryVirtualWindow {
  const layout = buildHistoryLayoutModel(entries, clientWidth, resolveEntryHeight);
  const visibleRange = computeHistoryIndexRange(
    entries,
    scrollTop,
    clientHeight,
    clientWidth,
    HISTORY_OVERSCAN_PX,
    resolveEntryHeight,
    layout,
  );
  const topSpacerPx = layout.prefixHeights[visibleRange.start] ?? 0;
  const visibleHeight =
    (layout.prefixHeights[visibleRange.end] ?? layout.totalHeight) - topSpacerPx;

  return {
    start: visibleRange.start,
    end: visibleRange.end,
    topSpacerPx,
    bottomSpacerPx: Math.max(0, layout.totalHeight - topSpacerPx - visibleHeight),
  };
}

export function computeHistoryVisibleRange(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth = typeof window === 'undefined' ? 960 : window.innerWidth,
  resolveEntryHeight?: HistoryHeightResolver,
): HistoryIndexRange {
  const layout = buildHistoryLayoutModel(entries, clientWidth, resolveEntryHeight);
  return computeHistoryIndexRange(
    entries,
    scrollTop,
    clientHeight,
    clientWidth,
    0,
    resolveEntryHeight,
    layout,
  );
}

function computeHistoryIndexRange(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth: number,
  overscanPx: number,
  resolveEntryHeight?: HistoryHeightResolver,
  layout?: HistoryLayoutModel,
): HistoryIndexRange {
  if (entries.length <= HISTORY_VIRTUALIZE_AFTER) {
    return {
      start: 0,
      end: entries.length,
    };
  }

  const currentLayout = layout ?? buildHistoryLayoutModel(entries, clientWidth, resolveEntryHeight);
  const targetTop = Math.max(0, scrollTop - overscanPx);
  const targetBottom = scrollTop + clientHeight + overscanPx;
  const start = findFirstIntersectingHistoryIndex(currentLayout.prefixHeights, targetTop);
  const end = Math.max(
    start + 1,
    Math.min(
      entries.length,
      findFirstHistoryEndAtOrAfter(currentLayout.prefixHeights, targetBottom),
    ),
  );

  return {
    start,
    end,
  };
}

function buildHistoryLayoutModel(
  entries: ReadonlyArray<LensHistoryEntry>,
  clientWidth: number,
  resolveEntryHeight?: HistoryHeightResolver,
): HistoryLayoutModel {
  const prefixHeights = new Array<number>(entries.length + 1);
  prefixHeights[0] = 0;
  const heightForEntry =
    resolveEntryHeight ??
    ((entry: LensHistoryEntry) => estimateHistoryEntryHeight(entry, clientWidth));

  let cumulativeHeight = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    cumulativeHeight += entry ? heightForEntry(entry, index) : 0;
    prefixHeights[index + 1] = cumulativeHeight;
  }

  return {
    prefixHeights,
    totalHeight: cumulativeHeight,
  };
}

function findFirstIntersectingHistoryIndex(
  prefixHeights: readonly number[],
  targetTop: number,
): number {
  let low = 1;
  let high = prefixHeights.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((prefixHeights[middle] ?? 0) > targetTop) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return Math.max(0, Math.min(prefixHeights.length - 2, low - 1));
}

function findFirstHistoryEndAtOrAfter(
  prefixHeights: readonly number[],
  targetBottom: number,
): number {
  let low = 1;
  let high = prefixHeights.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((prefixHeights[middle] ?? 0) >= targetBottom) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return Math.max(1, Math.min(prefixHeights.length - 1, low));
}

export function buildHistoryVirtualWindowKey(window: HistoryVirtualWindow): string {
  return `${window.start}:${window.end}`;
}

export function hasActiveLensSelectionInPanel(
  panel: ParentNode | null | undefined,
  selection:
    | Pick<Selection, 'rangeCount' | 'isCollapsed' | 'getRangeAt'>
    | null
    | undefined = resolveCurrentSelection(),
): boolean {
  if (!panel || !selection || selection.isCollapsed || selection.rangeCount <= 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  return panel.contains(startNode) || panel.contains(endNode);
}

function resolveCurrentSelection(): Pick<
  Selection,
  'rangeCount' | 'isCollapsed' | 'getRangeAt'
> | null {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return null;
  }

  return window.getSelection();
}
