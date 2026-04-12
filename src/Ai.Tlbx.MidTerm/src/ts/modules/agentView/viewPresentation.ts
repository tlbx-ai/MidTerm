import { normalizeLensProvider, resolveLensLayoutMode } from './activationHelpers';
import type { SessionLensViewState } from './types';

export function syncAgentViewPresentation(
  panel: HTMLDivElement,
  provider: string | null | undefined = null,
): void {
  panel.dataset.lensProvider = normalizeLensProvider(provider);
  panel.dataset.lensLayout = resolveLensLayoutMode(provider);
}

export function prepareLensForForeground(state: SessionLensViewState): void {
  state.historyAutoScrollPinned = true;
  state.historyLastScrollMetrics = null;
  state.historyLastUserScrollIntentAt = 0;
  state.pendingHistoryPrependAnchor = null;

  if (state.historyViewport) {
    state.historyViewport.scrollTop = 0;
  }
}
