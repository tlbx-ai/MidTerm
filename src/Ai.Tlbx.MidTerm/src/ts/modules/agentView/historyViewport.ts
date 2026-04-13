import { estimateHistoryEntryHeight } from './historyContent';
import type {
  HistoryIndexRange,
  HistoryScrollMetrics,
  HistoryVirtualWindow,
  LensHistoryEntry,
} from './types';

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const HISTORY_OVERSCAN_PX = 800;
export const HISTORY_VIRTUALIZE_AFTER = 50;

type HistoryHeightResolver = (entry: LensHistoryEntry, index: number) => number;

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

export function resolveHistoryAutoScrollPinned(args: {
  wasPinned: boolean;
  previous: HistoryScrollMetrics | null;
  current: HistoryScrollMetrics;
  userInitiated: boolean;
}): boolean {
  const nearBottom = isScrollContainerNearBottom(args.current);
  const userScrolledUp =
    args.previous !== null &&
    Number.isFinite(args.previous.scrollTop) &&
    Number.isFinite(args.current.scrollTop) &&
    args.current.scrollTop < args.previous.scrollTop - 1;

  if (args.userInitiated) {
    if (userScrolledUp) {
      return false;
    }

    return nearBottom;
  }

  if (args.wasPinned) {
    return true;
  }

  return nearBottom;
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
  const visibleRange = computeHistoryIndexRange(
    entries,
    scrollTop,
    clientHeight,
    clientWidth,
    HISTORY_OVERSCAN_PX,
    resolveEntryHeight,
  );
  const heightForEntry =
    resolveEntryHeight ??
    ((entry: LensHistoryEntry) => estimateHistoryEntryHeight(entry, clientWidth));
  const topSpacerPx = entries
    .slice(0, visibleRange.start)
    .reduce((sum, entry, index) => sum + heightForEntry(entry, index), 0);
  const visibleHeight = entries
    .slice(visibleRange.start, visibleRange.end)
    .reduce((sum, entry, index) => sum + heightForEntry(entry, visibleRange.start + index), 0);
  const totalHeight = entries.reduce((sum, entry, index) => sum + heightForEntry(entry, index), 0);

  return {
    start: visibleRange.start,
    end: visibleRange.end,
    topSpacerPx,
    bottomSpacerPx: Math.max(0, totalHeight - topSpacerPx - visibleHeight),
  };
}

export function computeHistoryVisibleRange(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth = typeof window === 'undefined' ? 960 : window.innerWidth,
  resolveEntryHeight?: HistoryHeightResolver,
): HistoryIndexRange {
  return computeHistoryIndexRange(
    entries,
    scrollTop,
    clientHeight,
    clientWidth,
    0,
    resolveEntryHeight,
  );
}

function computeHistoryIndexRange(
  entries: ReadonlyArray<LensHistoryEntry>,
  scrollTop: number,
  clientHeight: number,
  clientWidth: number,
  overscanPx: number,
  resolveEntryHeight?: HistoryHeightResolver,
): HistoryIndexRange {
  if (entries.length <= HISTORY_VIRTUALIZE_AFTER) {
    return {
      start: 0,
      end: entries.length,
    };
  }

  const targetTop = Math.max(0, scrollTop - overscanPx);
  const targetBottom = scrollTop + clientHeight + overscanPx;
  let cumulative = 0;
  let start = 0;
  const heightForEntry =
    resolveEntryHeight ??
    ((entry: LensHistoryEntry) => estimateHistoryEntryHeight(entry, clientWidth));

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    const height = heightForEntry(entry, index);
    if (cumulative + height >= targetTop) {
      start = index;
      break;
    }
    cumulative += height;
  }

  cumulative = entries
    .slice(0, start)
    .reduce((sum, entry, index) => sum + heightForEntry(entry, index), 0);
  let end = start;
  while (end < entries.length && cumulative < targetBottom) {
    const entry = entries[end];
    if (!entry) {
      break;
    }

    cumulative += heightForEntry(entry, end);
    end += 1;
  }

  return {
    start,
    end: Math.max(end, start + 1),
  };
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
