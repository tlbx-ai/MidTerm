import { resolveRepresentativeHistoryEntryHeight } from './historyMeasurements';

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
  return resolveRepresentativeHistoryEntryHeight(observedHeights);
}
