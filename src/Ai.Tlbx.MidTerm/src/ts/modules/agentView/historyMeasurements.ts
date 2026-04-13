import { estimateHistoryEntryHeight } from './historyContent';
import type { LensHistoryEntry, SessionLensViewState } from './types';

const HISTORY_MEASUREMENT_WIDTH_BUCKET_SIZE_PX = 40;
const HISTORY_MEASUREMENT_MIN_WIDTH_PX = 240;
const HISTORY_HEIGHT_SAMPLE_LIMIT = 6;
const DEFAULT_VISIBLE_ENTRY_HEIGHT_PX = 72;

function ensureHeightBucket<T>(
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

function ensureMeasurementBucketState(state: SessionLensViewState): void {
  const mutableState = state as {
    historyMeasuredHeightsByBucket?: Map<number, Map<string, number>>;
    historyObservedHeightsByBucket?: Map<number, Map<string, number>>;
    historyObservedHeightSamplesByBucket?: Map<number, Map<string, number[]>>;
    historyMeasuredHeights?: Map<string, number>;
    historyObservedHeights?: Map<string, number>;
  };
  mutableState.historyMeasuredHeightsByBucket ??= new Map<number, Map<string, number>>();
  mutableState.historyObservedHeightsByBucket ??= new Map<number, Map<string, number>>();
  mutableState.historyObservedHeightSamplesByBucket ??= new Map<number, Map<string, number[]>>();
  mutableState.historyMeasuredHeights ??= new Map<string, number>();
  mutableState.historyObservedHeights ??= new Map<string, number>();
  state.historyMeasuredHeightsByBucket = mutableState.historyMeasuredHeightsByBucket;
  state.historyObservedHeightsByBucket = mutableState.historyObservedHeightsByBucket;
  state.historyObservedHeightSamplesByBucket = mutableState.historyObservedHeightSamplesByBucket;
  state.historyMeasuredHeights = mutableState.historyMeasuredHeights;
  state.historyObservedHeights = mutableState.historyObservedHeights;
}

function resolveMedian(sample: readonly number[], fallback: number): number {
  const numericSample = sample.filter((value) => Number.isFinite(value) && value > 0);
  if (numericSample.length === 0) {
    return fallback;
  }

  numericSample.sort((left, right) => left - right);
  return numericSample[Math.floor(numericSample.length / 2)] ?? fallback;
}

function normalizeEstimatedHeight(height: number | null | undefined): number | null {
  if (!Number.isFinite(height) || (height ?? 0) <= 0) {
    return null;
  }

  const normalizedHeight = height ?? 0;
  return Math.max(1, Math.round(normalizedHeight));
}

export function resolveHistoryMeasurementWidthBucket(clientWidth: number): number {
  return Math.max(
    HISTORY_MEASUREMENT_MIN_WIDTH_PX,
    Math.round(clientWidth / HISTORY_MEASUREMENT_WIDTH_BUCKET_SIZE_PX) *
      HISTORY_MEASUREMENT_WIDTH_BUCKET_SIZE_PX,
  );
}

export function resolveHistoryWindowViewportWidth(
  viewport: Pick<HTMLDivElement, 'clientWidth'> | null | undefined,
): number | undefined {
  const clientWidth = Math.max(0, viewport?.clientWidth ?? 0);
  return clientWidth > 0 ? resolveHistoryMeasurementWidthBucket(clientWidth) : undefined;
}

export function activateHistoryMeasurementBucket(
  state: SessionLensViewState,
  clientWidth: number,
): number {
  ensureMeasurementBucketState(state);
  const widthBucket = resolveHistoryMeasurementWidthBucket(clientWidth);
  const measuredHeights = ensureHeightBucket(state.historyMeasuredHeightsByBucket, widthBucket);
  const observedHeights = ensureHeightBucket(state.historyObservedHeightsByBucket, widthBucket);
  ensureHeightBucket(state.historyObservedHeightSamplesByBucket, widthBucket);
  const changed =
    state.historyMeasuredWidthBucket !== widthBucket ||
    state.historyMeasuredHeights !== measuredHeights ||
    state.historyObservedHeights !== observedHeights;
  state.historyMeasuredWidthBucket = widthBucket;
  state.historyMeasuredHeights = measuredHeights;
  state.historyObservedHeights = observedHeights;
  if (changed) {
    state.historyLastVirtualWindowKey = null;
  }

  return widthBucket;
}

export function recordHistoryMeasuredHeight(
  state: SessionLensViewState,
  entryId: string,
  measuredHeight: number,
  clientWidth: number,
): boolean {
  const widthBucket = activateHistoryMeasurementBucket(state, clientWidth);
  const normalizedHeight = Math.max(1, Math.round(measuredHeight));
  const previousMeasuredHeight = state.historyMeasuredHeights.get(entryId);
  const sampleBuckets = ensureHeightBucket(state.historyObservedHeightSamplesByBucket, widthBucket);
  const samples = [...(sampleBuckets.get(entryId) ?? [])];
  if (samples[samples.length - 1] !== normalizedHeight) {
    samples.push(normalizedHeight);
    while (samples.length > HISTORY_HEIGHT_SAMPLE_LIMIT) {
      samples.shift();
    }
    sampleBuckets.set(entryId, samples);
  }

  const nextObservedHeight = resolveMedian(samples, normalizedHeight);
  const previousObservedHeight = state.historyObservedHeights.get(entryId);
  if (
    previousMeasuredHeight === normalizedHeight &&
    previousObservedHeight === nextObservedHeight
  ) {
    return false;
  }

  state.historyMeasuredHeights.set(entryId, normalizedHeight);
  state.historyObservedHeights.set(entryId, nextObservedHeight);
  state.historyLastVirtualWindowKey = null;
  return true;
}

export function resolveRepresentativeHistoryEntryHeight(
  observedHeights?: Iterable<number> | null,
): number {
  const sample: number[] = [];
  if (observedHeights) {
    for (const value of observedHeights) {
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      sample.push(value);
    }
  }

  return resolveMedian(sample, DEFAULT_VISIBLE_ENTRY_HEIGHT_PX);
}

export function resolveHistoryViewportEntryHeight(
  entry: LensHistoryEntry,
  state: SessionLensViewState | undefined,
  clientWidth: number,
): number {
  const estimatedHeight =
    normalizeEstimatedHeight(entry.estimatedHeightPx) ??
    estimateHistoryEntryHeight(entry, clientWidth);
  if (!state) {
    return estimatedHeight;
  }

  activateHistoryMeasurementBucket(state, clientWidth);
  return (
    state.historyMeasuredHeights.get(entry.id) ??
    state.historyObservedHeights.get(entry.id) ??
    estimatedHeight
  );
}
