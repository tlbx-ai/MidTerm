import { resolveRepresentativeHistoryEntryHeight } from './historyMeasurements';
import { resolveViewportDrivenHistoryWindowCount } from './historyWindowSizing';
import type { SessionLensViewState } from './types';

export interface LensHistoryVirtualizerConfig {
  overscanItems: number;
  fetchAheadItems: number;
}

export const DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG: LensHistoryVirtualizerConfig = {
  overscanItems: 12,
  fetchAheadItems: 30,
};

export function resolveLensHistoryFetchThresholdPx(
  state: SessionLensViewState,
  config: LensHistoryVirtualizerConfig = DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG,
): number {
  return Math.max(
    1,
    Math.round(
      resolveRepresentativeHistoryEntryHeight(state.historyObservedHeights.values()) *
        config.fetchAheadItems,
    ),
  );
}

export function resolveLensHistoryWindowTargetCount(
  viewport: HTMLDivElement | null | undefined,
  fallbackCount: number,
  observedHeights?: Iterable<number> | null,
  config: LensHistoryVirtualizerConfig = DEFAULT_LENS_HISTORY_VIRTUALIZER_CONFIG,
): number {
  return resolveViewportDrivenHistoryWindowCount(
    viewport,
    config.fetchAheadItems,
    fallbackCount,
    observedHeights,
  );
}
