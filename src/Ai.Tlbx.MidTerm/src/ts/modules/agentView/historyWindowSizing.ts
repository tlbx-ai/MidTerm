const DEFAULT_VISIBLE_ENTRY_HEIGHT_PX = 72;

export function resolveViewportDrivenHistoryWindowCount(
  viewport: HTMLDivElement | null | undefined,
  minimumMarginItems: number,
  maximumMarginItems: number,
  fallbackCount: number,
): number {
  const clientHeight = Math.max(0, viewport?.clientHeight ?? 0);
  if (clientHeight <= 0) {
    return fallbackCount;
  }

  const estimatedVisibleCount = Math.max(
    1,
    Math.ceil(clientHeight / DEFAULT_VISIBLE_ENTRY_HEIGHT_PX),
  );
  const marginCount = Math.max(
    minimumMarginItems,
    Math.min(maximumMarginItems, estimatedVisibleCount * 2),
  );
  return Math.max(estimatedVisibleCount + marginCount * 2, estimatedVisibleCount + 1);
}
