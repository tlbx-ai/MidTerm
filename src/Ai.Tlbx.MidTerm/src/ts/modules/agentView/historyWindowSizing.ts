import { resolveViewportDrivenWindowCount } from '../../utils/virtualizer';

export function resolveViewportDrivenHistoryWindowCount(
  viewport: HTMLDivElement | null | undefined,
  fetchAheadItems: number,
  fallbackCount: number,
  observedHeights?: Iterable<number> | null,
): number {
  return resolveViewportDrivenWindowCount({
    viewport,
    fetchAheadItems,
    fallbackCount,
    observedSizes: observedHeights,
  });
}
