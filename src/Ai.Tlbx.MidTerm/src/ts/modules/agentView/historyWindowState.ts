import {
  updateAppServerControlHistoryStreamWindow,
  type AppServerControlHistorySnapshot,
} from '../../api/client';
import type { SessionAppServerControlViewState } from './types';
import { buildAppServerControlHistoryEntries } from './historyProcessing';
import { applyAppServerControlHistoryWindowState } from './snapshotState';

export function hasRenderableAppServerControlHistory(
  snapshot: AppServerControlHistorySnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return false;
  }

  return (
    snapshot.latestSequence > 0 ||
    buildAppServerControlHistoryEntries(snapshot).length > 0 ||
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

export function applyFetchedAppServerControlHistoryWindow(
  sessionId: string,
  state: SessionAppServerControlViewState,
  snapshot: AppServerControlHistorySnapshot,
): boolean {
  const currentSnapshot = state.snapshot;
  const windowRevision = snapshot.windowRevision ?? null;
  if (
    state.historyWindowRevision &&
    windowRevision &&
    windowRevision !== state.historyWindowRevision
  ) {
    return false;
  }

  if (currentSnapshot && snapshot.latestSequence < currentSnapshot.latestSequence) {
    return false;
  }

  applyAppServerControlHistoryWindowState(state, snapshot);
  state.snapshot = snapshot;
  state.historyWindowRevision = windowRevision ?? state.historyWindowRevision;
  if (state.disconnectStream) {
    if (state.historyWindowViewportWidth == null) {
      updateAppServerControlHistoryStreamWindow(
        sessionId,
        state.historyWindowStart,
        state.historyWindowCount,
        state.historyWindowRevision ?? undefined,
      );
    } else {
      updateAppServerControlHistoryStreamWindow(
        sessionId,
        state.historyWindowStart,
        state.historyWindowCount,
        state.historyWindowRevision ?? undefined,
        state.historyWindowViewportWidth,
      );
    }
  }

  return true;
}
