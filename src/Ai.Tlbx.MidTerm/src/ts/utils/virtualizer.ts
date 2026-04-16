const VIRTUALIZER_MEASUREMENT_WIDTH_BUCKET_SIZE_PX = 40;
const VIRTUALIZER_MEASUREMENT_MIN_WIDTH_PX = 240;
const VIRTUALIZER_HEIGHT_SAMPLE_LIMIT = 6;
const DEFAULT_REPRESENTATIVE_ITEM_SIZE_PX = 72;
const UNSEEN_ITEM_SIZE_VARIANCE_LIMIT = 0.2;

export interface VirtualizerIndexRange {
  start: number;
  end: number;
}

export interface VirtualizerViewportMetrics {
  scrollTop: number;
  clientHeight: number;
  clientWidth: number;
}

export interface VirtualizerWindow {
  start: number;
  end: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
}

export interface VirtualizerRetainedWindowDescriptor {
  windowStart: number;
  windowEnd: number;
  totalCount: number;
}

export interface VirtualizerWindowViewportMetrics extends VirtualizerViewportMetrics {
  retainedWindowStart: number;
  retainedWindowEnd: number;
  totalCount: number;
  offWindowTopSpacerPx: number;
  effectiveOffWindowTopSpacerPx: number;
  offWindowBottomSpacerPx: number;
}

export interface VirtualizerAnchor<TKey extends string = string> {
  key: TKey;
  topOffsetPx: number;
  absoluteIndex: number;
}

export interface VirtualizerMeasurementState<TKey extends string = string> {
  measuredSizes: Map<TKey, number>;
  observedSizes: Map<TKey, number>;
  measuredSizesByBucket: Map<number, Map<TKey, number>>;
  observedSizesByBucket: Map<number, Map<TKey, number>>;
  observedSizeSamplesByBucket: Map<number, Map<TKey, number[]>>;
  measuredWidthBucket: number;
  lastWindowKey: string | null;
}

export interface VirtualizerRenderedNode<TKey extends string = string> {
  key: TKey;
  node: HTMLElement;
  absoluteIndex: number;
}

export interface VirtualizerMeasuredItemChange {
  absoluteIndex: number;
  previousSize: number;
  nextSize: number;
}

type SizeResolver<TItem> = (item: TItem, index: number) => number;
type OptionalSizeResolver<TItem> = (item: TItem, index: number) => number | null | undefined;

interface LayoutModel {
  prefixSizes: number[];
  totalSize: number;
}

function ensureBucket<T>(
  buckets: Map<number, Map<string, T>>,
  widthBucket: number,
): Map<string, T> {
  let bucket = buckets.get(widthBucket);
  if (!bucket) {
    bucket = new Map<string, T>();
    buckets.set(widthBucket, bucket);
  }

  return bucket;
}

function resolveMedian(sample: readonly number[], fallback: number): number {
  const numericSample = sample.filter((value) => Number.isFinite(value) && value > 0);
  if (numericSample.length === 0) {
    return fallback;
  }

  numericSample.sort((left, right) => left - right);
  return numericSample[Math.floor(numericSample.length / 2)] ?? fallback;
}

function countFiniteSizes(observedSizes: Iterable<number> | null | undefined): number {
  let count = 0;
  if (!observedSizes) {
    return 0;
  }

  for (const value of observedSizes) {
    if (Number.isFinite(value) && value > 0) {
      count += 1;
    }
  }

  return count;
}

function resolveAverageFromResolver<TItem>(
  items: readonly TItem[],
  resolveSize: OptionalSizeResolver<TItem> | undefined,
): number | null {
  if (!resolveSize || items.length === 0) {
    return null;
  }

  let totalSize = 0;
  let count = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }

    const resolvedSize = resolveSize(item, index);
    if (!Number.isFinite(resolvedSize) || (resolvedSize ?? 0) <= 0) {
      continue;
    }

    totalSize += resolvedSize ?? 0;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return Math.max(1, totalSize / count);
}

function clampUnseenItemSizeEstimate(sampleSize: number, representativeSize: number): number {
  const minimum = representativeSize * (1 - UNSEEN_ITEM_SIZE_VARIANCE_LIMIT);
  const maximum = representativeSize * (1 + UNSEEN_ITEM_SIZE_VARIANCE_LIMIT);
  return Math.max(1, Math.min(maximum, Math.max(minimum, sampleSize)));
}

function buildLayoutModel<TItem>(
  items: ReadonlyArray<TItem>,
  resolveItemSize: SizeResolver<TItem>,
): LayoutModel {
  const prefixSizes = new Array<number>(items.length + 1);
  prefixSizes[0] = 0;
  let cumulativeSize = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    cumulativeSize += item ? resolveItemSize(item, index) : 0;
    prefixSizes[index + 1] = cumulativeSize;
  }

  return {
    prefixSizes,
    totalSize: cumulativeSize,
  };
}

function findFirstIntersectingIndex(prefixSizes: readonly number[], targetTop: number): number {
  let low = 1;
  let high = prefixSizes.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((prefixSizes[middle] ?? 0) > targetTop) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return Math.max(0, Math.min(prefixSizes.length - 2, low - 1));
}

function findFirstEndAtOrAfter(prefixSizes: readonly number[], targetBottom: number): number {
  let low = 1;
  let high = prefixSizes.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((prefixSizes[middle] ?? 0) >= targetBottom) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return Math.max(1, Math.min(prefixSizes.length - 1, low));
}

function resolveAverageUnseenItemSize<TItem>(
  items: readonly TItem[],
  observedSizes: Iterable<number> | null | undefined,
  resolveItemSize: SizeResolver<TItem>,
  resolveEstimatedItemSize: OptionalSizeResolver<TItem> | undefined,
): number {
  const representativeSize = resolveRepresentativeItemSize(observedSizes);
  const observedCount = countFiniteSizes(observedSizes);
  if (items.length === 0) {
    return representativeSize;
  }

  const estimatedAverage =
    resolveAverageFromResolver(items, resolveEstimatedItemSize) ??
    resolveAverageFromResolver(items, resolveItemSize);
  if (estimatedAverage === null) {
    return representativeSize;
  }

  if (observedCount === 0) {
    return estimatedAverage;
  }

  return clampUnseenItemSizeEstimate(estimatedAverage, representativeSize);
}

function estimateOffWindowSpacerPx<TItem>(args: {
  items: readonly TItem[];
  observedSizes?: Iterable<number> | null | undefined;
  unseenItemCount: number;
  resolveItemSize: SizeResolver<TItem>;
  resolveEstimatedItemSize?: OptionalSizeResolver<TItem> | undefined;
}): number {
  if (args.unseenItemCount <= 0) {
    return 0;
  }

  const averageSize = resolveAverageUnseenItemSize(
    args.items,
    args.observedSizes,
    args.resolveItemSize,
    args.resolveEstimatedItemSize,
  );
  return Math.max(0, Math.round(averageSize * args.unseenItemCount));
}

export function resolveVirtualizerMeasurementWidthBucket(clientWidth: number): number {
  return Math.max(
    VIRTUALIZER_MEASUREMENT_MIN_WIDTH_PX,
    Math.round(clientWidth / VIRTUALIZER_MEASUREMENT_WIDTH_BUCKET_SIZE_PX) *
      VIRTUALIZER_MEASUREMENT_WIDTH_BUCKET_SIZE_PX,
  );
}

export function resolveVirtualizerViewportWidth(
  viewport: Pick<HTMLDivElement, 'clientWidth'> | null | undefined,
): number | undefined {
  const clientWidth = Math.max(0, viewport?.clientWidth ?? 0);
  return clientWidth > 0 ? resolveVirtualizerMeasurementWidthBucket(clientWidth) : undefined;
}

export function activateVirtualizerMeasurementBucket(
  state: VirtualizerMeasurementState,
  clientWidth: number,
): number {
  const widthBucket = resolveVirtualizerMeasurementWidthBucket(clientWidth);
  const measuredSizes = ensureBucket(state.measuredSizesByBucket, widthBucket);
  const observedSizes = ensureBucket(state.observedSizesByBucket, widthBucket);
  ensureBucket(state.observedSizeSamplesByBucket, widthBucket);
  const changed =
    state.measuredWidthBucket !== widthBucket ||
    state.measuredSizes !== measuredSizes ||
    state.observedSizes !== observedSizes;
  state.measuredWidthBucket = widthBucket;
  state.measuredSizes = measuredSizes;
  state.observedSizes = observedSizes;
  if (changed) {
    state.lastWindowKey = null;
  }

  return widthBucket;
}

export function recordMeasuredItemSize(
  state: VirtualizerMeasurementState,
  key: string,
  measuredSize: number,
  clientWidth: number,
): boolean {
  const widthBucket = activateVirtualizerMeasurementBucket(state, clientWidth);
  const normalizedSize = Math.max(1, Math.round(measuredSize));
  const previousMeasuredSize = state.measuredSizes.get(key);
  const sampleBuckets = ensureBucket(state.observedSizeSamplesByBucket, widthBucket);
  const samples = [...(sampleBuckets.get(key) ?? [])];
  if (samples[samples.length - 1] !== normalizedSize) {
    samples.push(normalizedSize);
    while (samples.length > VIRTUALIZER_HEIGHT_SAMPLE_LIMIT) {
      samples.shift();
    }
    sampleBuckets.set(key, samples);
  }

  const nextObservedSize = resolveMedian(samples, normalizedSize);
  const previousObservedSize = state.observedSizes.get(key);
  if (previousMeasuredSize === normalizedSize && previousObservedSize === nextObservedSize) {
    return false;
  }

  state.measuredSizes.set(key, normalizedSize);
  state.observedSizes.set(key, nextObservedSize);
  state.lastWindowKey = null;
  return true;
}

export function resolveRepresentativeItemSize(observedSizes?: Iterable<number> | null): number {
  const sample: number[] = [];
  if (observedSizes) {
    for (const value of observedSizes) {
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      sample.push(value);
    }
  }

  return resolveMedian(sample, DEFAULT_REPRESENTATIVE_ITEM_SIZE_PX);
}

export function computeVisibleRange<TItem>(args: {
  items: ReadonlyArray<TItem>;
  scrollTop: number;
  clientHeight: number;
  overscanItems?: number;
  resolveItemSize: SizeResolver<TItem>;
}): VirtualizerIndexRange {
  const { items, scrollTop, clientHeight, overscanItems = 0, resolveItemSize } = args;
  if (items.length === 0) {
    return { start: 0, end: 0 };
  }

  const layout = buildLayoutModel(items, resolveItemSize);
  const visibleStart = findFirstIntersectingIndex(layout.prefixSizes, scrollTop);
  const visibleEnd = Math.max(
    visibleStart + 1,
    Math.min(items.length, findFirstEndAtOrAfter(layout.prefixSizes, scrollTop + clientHeight)),
  );

  return {
    start: Math.max(0, visibleStart - Math.max(0, overscanItems)),
    end: Math.min(items.length, visibleEnd + Math.max(0, overscanItems)),
  };
}

export function computeVirtualWindow<TItem>(args: {
  items: ReadonlyArray<TItem>;
  scrollTop: number;
  clientHeight: number;
  overscanItems?: number;
  resolveItemSize: SizeResolver<TItem>;
}): VirtualizerWindow {
  const { items, resolveItemSize } = args;
  const visibleRange = computeVisibleRange(args);
  const layout = buildLayoutModel(items, resolveItemSize);
  const topSpacerPx = layout.prefixSizes[visibleRange.start] ?? 0;
  const visibleSize = (layout.prefixSizes[visibleRange.end] ?? layout.totalSize) - topSpacerPx;

  return {
    start: visibleRange.start,
    end: visibleRange.end,
    topSpacerPx,
    bottomSpacerPx: Math.max(0, layout.totalSize - topSpacerPx - visibleSize),
  };
}

export function buildVirtualizerWindowKey(window: VirtualizerWindow): string {
  return `${window.start}:${window.end}`;
}

export function resolveRetainedWindowViewportMetrics<TItem>(args: {
  items: readonly TItem[];
  viewportMetrics: VirtualizerViewportMetrics;
  retainedWindow: VirtualizerRetainedWindowDescriptor;
  observedSizes?: Iterable<number> | null | undefined;
  resolveItemSize: SizeResolver<TItem>;
  resolveEstimatedItemSize?: OptionalSizeResolver<TItem> | undefined;
}): VirtualizerWindowViewportMetrics {
  const {
    items,
    viewportMetrics,
    retainedWindow,
    observedSizes,
    resolveItemSize,
    resolveEstimatedItemSize,
  } = args;
  const offWindowTopCount = Math.max(0, retainedWindow.windowStart);
  const offWindowBottomCount = Math.max(0, retainedWindow.totalCount - retainedWindow.windowEnd);
  const offWindowTopSpacerPx = estimateOffWindowSpacerPx({
    items,
    observedSizes,
    unseenItemCount: offWindowTopCount,
    resolveItemSize,
    resolveEstimatedItemSize,
  });
  const effectiveOffWindowTopSpacerPx = Math.min(
    offWindowTopSpacerPx,
    Math.max(0, viewportMetrics.scrollTop),
  );
  const offWindowBottomSpacerPx = estimateOffWindowSpacerPx({
    items,
    observedSizes,
    unseenItemCount: offWindowBottomCount,
    resolveItemSize,
    resolveEstimatedItemSize,
  });

  return {
    ...viewportMetrics,
    scrollTop: Math.max(0, viewportMetrics.scrollTop - effectiveOffWindowTopSpacerPx),
    retainedWindowStart: retainedWindow.windowStart,
    retainedWindowEnd: retainedWindow.windowEnd,
    totalCount: retainedWindow.totalCount,
    offWindowTopSpacerPx,
    effectiveOffWindowTopSpacerPx,
    offWindowBottomSpacerPx,
  };
}

export function resolveViewportDrivenWindowCount(args: {
  viewport: Pick<HTMLDivElement, 'clientHeight'> | null | undefined;
  fetchAheadItems: number;
  fallbackCount: number;
  observedSizes?: Iterable<number> | null | undefined;
}): number {
  const clientHeight = Math.max(0, args.viewport?.clientHeight ?? 0);
  if (clientHeight <= 0) {
    return args.fallbackCount;
  }

  const representativeItemSize = resolveRepresentativeItemSize(args.observedSizes);
  const estimatedVisibleCount = Math.max(1, Math.ceil(clientHeight / representativeItemSize));
  return Math.max(
    estimatedVisibleCount + Math.max(0, args.fetchAheadItems) * 2,
    estimatedVisibleCount + 1,
  );
}

export function resolveViewportCenteredWindowRequest<TItem>(args: {
  items: readonly TItem[];
  viewportMetrics: VirtualizerViewportMetrics;
  retainedWindow: VirtualizerRetainedWindowDescriptor;
  fetchAheadItems: number;
  resolveItemSize: SizeResolver<TItem>;
  observedSizes?: Iterable<number> | null | undefined;
  anchorAbsoluteIndex?: number | null | undefined;
  resolveEstimatedItemSize?: OptionalSizeResolver<TItem>;
}): { startIndex: number; count: number } | null {
  const {
    items,
    viewportMetrics,
    retainedWindow,
    fetchAheadItems,
    resolveItemSize,
    observedSizes,
    resolveEstimatedItemSize,
  } = args;
  if (items.length === 0) {
    return null;
  }

  if (retainedWindow.windowStart <= 0 && retainedWindow.windowEnd >= retainedWindow.totalCount) {
    return null;
  }

  const windowMetrics = resolveRetainedWindowViewportMetrics({
    items,
    viewportMetrics,
    retainedWindow,
    observedSizes,
    resolveItemSize,
    resolveEstimatedItemSize,
  });
  const visibleRange = computeVisibleRange({
    items,
    scrollTop: windowMetrics.scrollTop,
    clientHeight: windowMetrics.clientHeight,
    overscanItems: 0,
    resolveItemSize,
  });
  const absoluteVisibleStart = retainedWindow.windowStart + visibleRange.start;
  const absoluteVisibleEnd = retainedWindow.windowStart + visibleRange.end;
  const marginItems = Math.max(0, fetchAheadItems);
  const safeStart = retainedWindow.windowStart + marginItems;
  const safeEnd = retainedWindow.windowEnd - marginItems;
  const needsShift =
    absoluteVisibleStart < safeStart ||
    absoluteVisibleEnd > safeEnd ||
    retainedWindow.windowEnd - retainedWindow.windowStart >
      Math.max(1, visibleRange.end - visibleRange.start) + marginItems * 2;
  if (!needsShift) {
    return null;
  }

  const desiredStart = Math.max(0, absoluteVisibleStart - marginItems);
  const desiredEnd = Math.min(retainedWindow.totalCount, absoluteVisibleEnd + marginItems);
  const anchorAbsoluteIndex =
    typeof args.anchorAbsoluteIndex === 'number' && Number.isFinite(args.anchorAbsoluteIndex)
      ? Math.max(0, Math.min(retainedWindow.totalCount - 1, args.anchorAbsoluteIndex))
      : null;
  const anchoredStart =
    anchorAbsoluteIndex === null ? desiredStart : Math.min(desiredStart, anchorAbsoluteIndex);
  const anchoredEnd =
    anchorAbsoluteIndex === null ? desiredEnd : Math.max(desiredEnd, anchorAbsoluteIndex + 1);
  const desiredCount = Math.max(1, anchoredEnd - anchoredStart);
  const maxStart = Math.max(0, retainedWindow.totalCount - desiredCount);
  const startIndex = Math.max(0, Math.min(anchoredStart, maxStart));
  const count = Math.min(retainedWindow.totalCount - startIndex, desiredCount);
  if (
    startIndex === retainedWindow.windowStart &&
    count === retainedWindow.windowEnd - retainedWindow.windowStart
  ) {
    return null;
  }

  return { startIndex, count };
}

export function syncViewportScrollPosition(
  viewport: HTMLDivElement,
  targetScrollTop: number,
): boolean {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const nextScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
  if (Math.abs(nextScrollTop - viewport.scrollTop) <= 1) {
    return false;
  }

  viewport.scrollTop = nextScrollTop;
  return Math.abs(viewport.scrollTop - nextScrollTop) <= 1;
}

export function captureViewportAnchor<TKey extends string = string>(args: {
  viewport: HTMLDivElement;
  renderedNodes: Iterable<VirtualizerRenderedNode<TKey>>;
}): VirtualizerAnchor<TKey> | null {
  const viewportRect = args.viewport.getBoundingClientRect();
  let bestAnchor: VirtualizerAnchor<TKey> | null = null;
  for (const rendered of args.renderedNodes) {
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
        key: rendered.key,
        topOffsetPx,
        absoluteIndex: rendered.absoluteIndex,
      };
    }
  }

  return bestAnchor;
}

export function restoreViewportAnchor<TKey extends string = string>(args: {
  viewport: HTMLDivElement;
  anchor: VirtualizerAnchor<TKey>;
  resolveNode: (key: TKey) => HTMLElement | null | undefined;
}): boolean {
  const anchorNode = args.resolveNode(args.anchor.key);
  if (!anchorNode || typeof anchorNode.getBoundingClientRect !== 'function') {
    return false;
  }

  const viewportRect = args.viewport.getBoundingClientRect();
  const anchorRect = anchorNode.getBoundingClientRect();
  return syncViewportScrollPosition(
    args.viewport,
    args.viewport.scrollTop + (anchorRect.top - viewportRect.top - args.anchor.topOffsetPx),
  );
}

export function resolveScrollCompensationDelta(args: {
  changes: readonly VirtualizerMeasuredItemChange[];
  anchorAbsoluteIndex: number | null | undefined;
}): number {
  if (args.anchorAbsoluteIndex === null || args.anchorAbsoluteIndex === undefined) {
    return 0;
  }

  let delta = 0;
  for (const change of args.changes) {
    if (change.absoluteIndex >= args.anchorAbsoluteIndex) {
      continue;
    }

    delta += change.nextSize - change.previousSize;
  }

  return delta;
}
