import { updateLensHistoryStreamWindow, type LensHistorySnapshot } from '../../api/client';
import type { SessionLensViewState } from './types';
import { buildLensHistoryEntries } from './historyProcessing';
import { applyLensHistoryWindowState } from './snapshotState';

export function hasRenderableLensHistory(
  snapshot: LensHistorySnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.latestSequence > 0 ||
    buildLensHistoryEntries(snapshot).length > 0 ||
    snapshot.items.length > 0 ||
    snapshot.requests.length > 0 ||
    Boolean(snapshot.streams.assistantText.trim()) ||
    Boolean(snapshot.streams.reasoningText.trim()) ||
    Boolean(snapshot.streams.reasoningSummaryText.trim()) ||
    Boolean(snapshot.streams.planText.trim()) ||
    Boolean(snapshot.streams.commandOutput.trim()) ||
    Boolean(snapshot.streams.fileChangeOutput.trim()) ||
    Boolean(snapshot.streams.unifiedDiff.trim())
  );
}

export function applyFetchedLensHistoryWindow(
  sessionId: string,
  state: SessionLensViewState,
  snapshot: LensHistorySnapshot,
): boolean {
  const currentSnapshot = state.snapshot;
  if (currentSnapshot && snapshot.latestSequence < currentSnapshot.latestSequence) {
    return false;
  }

  applyLensHistoryWindowState(state, snapshot);
  state.snapshot = snapshot;
  if (state.disconnectStream) {
    updateLensHistoryStreamWindow(sessionId, state.historyWindowStart, state.historyWindowCount);
  }

  return true;
}
