const DEFAULT_VISIBLE_ENTRY_HEIGHT_PX = 72;
const OBSERVED_HEIGHT_SAMPLE_LIMIT = 24;

export function resolveViewportDrivenHistoryWindowCount(
  viewport: HTMLDivElement | null | undefined,
  minimumMarginItems: number,
  maximumMarginItems: number,
  fallbackCount: number,
  observedHeights?: Iterable<number> | null,
): number {
  const clientHeight = Math.max(0, viewport?.clientHeight ?? 0);
  if (clientHeight <= 0) {
    return fallbackCount;
  }

  const representativeEntryHeight = resolveRepresentativeEntryHeight(observedHeights);
  const estimatedVisibleCount = Math.max(1, Math.ceil(clientHeight / representativeEntryHeight));
  const marginCount = Math.max(
    minimumMarginItems,
    Math.min(maximumMarginItems, estimatedVisibleCount * 2),
  );
  return Math.max(estimatedVisibleCount + marginCount * 2, estimatedVisibleCount + 1);
}

function resolveRepresentativeEntryHeight(observedHeights?: Iterable<number> | null): number {
  if (!observedHeights) {
    return DEFAULT_VISIBLE_ENTRY_HEIGHT_PX;
  }

  const sample: number[] = [];
  for (const value of observedHeights) {
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    sample.push(value);
    if (sample.length > OBSERVED_HEIGHT_SAMPLE_LIMIT) {
      sample.shift();
    }
  }

  if (sample.length === 0) {
    return DEFAULT_VISIBLE_ENTRY_HEIGHT_PX;
  }

  sample.sort((left, right) => left - right);
  return sample[Math.floor(sample.length / 2)] ?? DEFAULT_VISIBLE_ENTRY_HEIGHT_PX;
}
