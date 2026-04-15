import { resolveRepresentativeHistoryEntryHeight } from './historyMeasurements';
import { resolveViewportDrivenHistoryWindowCount } from './historyWindowSizing';
import type { SessionLensViewState } from './types';

export interface LensHistoryVirtualizerConfig {
  overscanItems: number;
  fetchAheadItems: number;
}

export const LENS_HISTORY_MIN_FETCH_AHEAD_ITEMS = 20;

export const DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG: LensHistoryVirtualizerConfig = {
  overscanItems: 12,
  fetchAheadItems: 30,
};

export function resolveLensHistoryFetchAheadItems(
  config: LensHistoryVirtualizerConfig = DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG,
): number {
  return Math.max(LENS_HISTORY_MIN_FETCH_AHEAD_ITEMS, config.fetchAheadItems);
}

export function resolveLensHistoryFetchThresholdPx(
  state: SessionLensViewState,
  config: LensHistoryVirtualizerConfig = DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG,
): number {
  const fetchAheadItems = resolveLensHistoryFetchAheadItems(config);
  return Math.max(
    1,
    Math.round(
      resolveRepresentativeHistoryEntryHeight(state.historyObservedHeights.values()) *
        fetchAheadItems,
    ),
  );
}

export function resolveLensHistoryWindowTargetCount(
  viewport: HTMLDivElement | null | undefined,
  fallbackCount: number,
  observedHeights?: Iterable<number> | null,
  config: LensHistoryVirtualizerConfig = DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG,
): number {
  const fetchAheadItems = resolveLensHistoryFetchAheadItems(config);
  return resolveViewportDrivenHistoryWindowCount(
    viewport,
    fetchAheadItems,
    fallbackCount,
    observedHeights,
  );
}
