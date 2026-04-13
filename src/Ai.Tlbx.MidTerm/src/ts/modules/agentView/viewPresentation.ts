import { normalizeLensProvider, resolveLensLayoutMode } from './activationHelpers';
import { setHistoryScrollMode } from './historyViewport';
import type { SessionLensViewState } from './types';

export function syncAgentViewPresentation(
  panel: HTMLDivElement,
  provider: string | null | undefined = null,
): void {
  panel.dataset.lensProvider = normalizeLensProvider(provider);
  panel.dataset.lensLayout = resolveLensLayoutMode(provider);
}

export function prepareLensForForeground(state: SessionLensViewState): void {
  setHistoryScrollMode(state, 'follow');
  state.historyLastScrollMetrics = null;
  state.historyLastUserScrollIntentAt = 0;
  state.pendingHistoryPrependAnchor = null;

  if (state.historyViewport) {
    state.historyViewport.scrollTop = 0;
  }
}
