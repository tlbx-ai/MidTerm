import type {
  LensPulseDeltaResponse,
  LensPulseHistoryEntry,
  LensPulseSnapshotResponse,
} from '../../api/client';
import type { LensAttachmentReference } from '../../api/types';
import type { SessionLensViewState } from './types';

const LENS_HISTORY_WINDOW_SIZE = 80;

function cloneHistoryAttachments(
  attachments: readonly LensAttachmentReference[] | undefined,
): LensAttachmentReference[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

export function applyLensSnapshotWindowState(
  state: SessionLensViewState,
  snapshot: LensPulseSnapshotResponse,
): void {
  const windowStart =
    typeof snapshot.historyWindowStart === 'number' ? snapshot.historyWindowStart : 0;
  const windowEnd =
    typeof snapshot.historyWindowEnd === 'number'
      ? snapshot.historyWindowEnd
      : windowStart + snapshot.transcript.length;
  const windowSize = Math.max(0, windowEnd - windowStart);
  state.historyWindowStart = windowStart;
  state.historyWindowCount = Math.max(windowSize, LENS_HISTORY_WINDOW_SIZE);
}

export function collapseSnapshotToLatestWindow(
  state: SessionLensViewState,
  targetWindowCount: number,
): void {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const retainedEntries =
    snapshot.transcript.length > targetWindowCount
      ? snapshot.transcript.slice(-targetWindowCount)
      : snapshot.transcript.slice();
  const totalHistoryCount = Math.max(snapshot.totalHistoryCount, retainedEntries.length);
  const retainedEstimatedHeightPx = sumEstimatedHistoryHeights(retainedEntries);

  snapshot.transcript = retainedEntries;
  snapshot.totalHistoryCount = totalHistoryCount;
  snapshot.estimatedTotalHistoryHeightPx = Math.max(
    snapshot.estimatedTotalHistoryHeightPx ?? 0,
    retainedEstimatedHeightPx,
  );
  snapshot.estimatedHistoryBeforeWindowPx = Math.max(
    0,
    snapshot.estimatedTotalHistoryHeightPx - retainedEstimatedHeightPx,
  );
  snapshot.estimatedHistoryAfterWindowPx = 0;
  snapshot.historyWindowEnd = totalHistoryCount;
  snapshot.historyWindowStart = Math.max(0, snapshot.historyWindowEnd - retainedEntries.length);
  snapshot.hasOlderHistory = snapshot.historyWindowStart > 0;
  snapshot.hasNewerHistory = false;
  state.historyWindowStart = snapshot.historyWindowStart;
  state.historyWindowCount = Math.max(targetWindowCount, retainedEntries.length);
}

export function applyCanonicalLensDelta(
  state: SessionLensViewState,
  delta: LensPulseDeltaResponse,
): boolean {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return false;
  }

  const previousTotalHistoryCount = snapshot.totalHistoryCount;
  snapshot.estimatedTotalHistoryHeightPx = Math.max(
    delta.estimatedTotalHistoryHeightPx ?? 0,
    snapshot.estimatedTotalHistoryHeightPx ?? 0,
  );
  snapshot.provider = delta.provider || snapshot.provider;
  snapshot.generatedAt = delta.generatedAt;
  snapshot.latestSequence = Math.max(snapshot.latestSequence, delta.latestSequence);
  snapshot.totalHistoryCount = Math.max(delta.totalHistoryCount, snapshot.totalHistoryCount);
  snapshot.session = cloneSnapshotSessionSummary(delta.session);
  snapshot.thread = cloneSnapshotThreadSummary(delta.thread);
  snapshot.currentTurn = cloneSnapshotTurnSummary(delta.currentTurn);
  snapshot.quickSettings = cloneSnapshotQuickSettingsSummary(delta.quickSettings);
  snapshot.streams = cloneSnapshotStreamsSummary(delta.streams);
  snapshot.items = upsertSnapshotItems(snapshot.items, delta.itemUpserts, delta.itemRemovals);
  snapshot.requests = upsertSnapshotRequests(
    snapshot.requests,
    delta.requestUpserts,
    delta.requestRemovals,
  );
  snapshot.notices = upsertSnapshotNotices(snapshot.notices, delta.noticeUpserts);
  return applyHistoryWindowDelta(
    state,
    snapshot,
    previousTotalHistoryCount,
    delta.historyUpserts,
    delta.historyRemovals,
  );
}

function applyHistoryWindowDelta(
  state: SessionLensViewState,
  snapshot: LensPulseSnapshotResponse,
  previousTotalHistoryCount: number,
  upserts: readonly LensPulseHistoryEntry[],
  removals: readonly string[],
): boolean {
  const currentWindowStart = snapshot.historyWindowStart;
  const currentWindowEnd = snapshot.historyWindowEnd;
  const wasLiveEdge = currentWindowEnd >= previousTotalHistoryCount;
  const nextEntries = snapshot.transcript.map(cloneSnapshotHistoryEntry);
  const entryIndexById = new Map(nextEntries.map((entry, index) => [entry.entryId, index]));
  const requiresWindowRefresh = resolveHistoryWindowRefreshRequirement(
    wasLiveEdge,
    currentWindowStart,
    currentWindowEnd,
    upserts,
    removals,
    entryIndexById,
  );

  applyHistoryEntryRemovals(nextEntries, entryIndexById, removals);
  applyHistoryEntryUpserts(
    nextEntries,
    entryIndexById,
    upserts,
    wasLiveEdge,
    currentWindowStart,
    currentWindowEnd,
  );

  nextEntries.sort((left, right) => left.order - right.order);
  const targetWindowCount = Math.max(1, state.historyWindowCount || LENS_HISTORY_WINDOW_SIZE);
  applyHistoryWindowEntries(
    snapshot,
    nextEntries,
    wasLiveEdge,
    currentWindowStart,
    currentWindowEnd,
    targetWindowCount,
    requiresWindowRefresh,
  );

  snapshot.hasOlderHistory = snapshot.historyWindowStart > 0;
  snapshot.hasNewerHistory = snapshot.historyWindowEnd < snapshot.totalHistoryCount;
  state.historyWindowStart = snapshot.historyWindowStart;
  state.historyWindowCount = Math.max(snapshot.transcript.length, targetWindowCount);
  return requiresWindowRefresh;
}

function resolveHistoryWindowRefreshRequirement(
  wasLiveEdge: boolean,
  currentWindowStart: number,
  currentWindowEnd: number,
  upserts: readonly LensPulseHistoryEntry[],
  removals: readonly string[],
  entryIndexById: ReadonlyMap<string, number>,
): boolean {
  if (wasLiveEdge) {
    return false;
  }

  const hasOffWindowUpsert = upserts.some((upsert) => {
    const absoluteIndex = Math.max(0, upsert.order - 1);
    return absoluteIndex < currentWindowStart || absoluteIndex >= currentWindowEnd;
  });
  const hasOffWindowRemoval =
    removals.length > 0 && removals.some((entryId) => !entryIndexById.has(entryId));
  return hasOffWindowUpsert || hasOffWindowRemoval;
}

function applyHistoryEntryRemovals(
  entries: LensPulseHistoryEntry[],
  entryIndexById: Map<string, number>,
  removals: readonly string[],
): void {
  for (const entryId of removals) {
    const index = entryIndexById.get(entryId);
    if (index === undefined) {
      continue;
    }

    entries.splice(index, 1);
    entryIndexById.delete(entryId);
    reindexHistoryEntryMap(entryIndexById, entries);
  }
}

function applyHistoryEntryUpserts(
  entries: LensPulseHistoryEntry[],
  entryIndexById: Map<string, number>,
  upserts: readonly LensPulseHistoryEntry[],
  wasLiveEdge: boolean,
  currentWindowStart: number,
  currentWindowEnd: number,
): void {
  for (const upsert of upserts) {
    const cloned = cloneSnapshotHistoryEntry(upsert);
    const existingIndex = entryIndexById.get(cloned.entryId);
    if (existingIndex !== undefined) {
      entries.splice(existingIndex, 1, cloned);
      continue;
    }

    if (wasLiveEdge) {
      entries.push(cloned);
      entryIndexById.set(cloned.entryId, entries.length - 1);
      continue;
    }

    const absoluteIndex = Math.max(0, cloned.order - 1);
    if (absoluteIndex >= currentWindowStart && absoluteIndex < currentWindowEnd) {
      entries.push(cloned);
      entryIndexById.set(cloned.entryId, entries.length - 1);
    }
  }
}

function applyHistoryWindowEntries(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensPulseHistoryEntry[],
  wasLiveEdge: boolean,
  currentWindowStart: number,
  currentWindowEnd: number,
  targetWindowCount: number,
  requiresWindowRefresh: boolean,
): void {
  if (wasLiveEdge) {
    applyLiveEdgeHistoryWindow(snapshot, entries, targetWindowCount);
    return;
  }

  snapshot.transcript = entries.filter((entry) => {
    const absoluteIndex = Math.max(0, entry.order - 1);
    return absoluteIndex >= currentWindowStart && absoluteIndex < currentWindowEnd;
  });
  snapshot.historyWindowStart = currentWindowStart;
  snapshot.historyWindowEnd = snapshot.historyWindowStart + snapshot.transcript.length;
  if (requiresWindowRefresh) {
    return;
  }

  const currentWindowEstimatedHeightPx = sumEstimatedHistoryHeights(snapshot.transcript);
  snapshot.estimatedHistoryAfterWindowPx = Math.max(
    0,
    (snapshot.estimatedTotalHistoryHeightPx ?? 0) -
      (snapshot.estimatedHistoryBeforeWindowPx ?? 0) -
      currentWindowEstimatedHeightPx,
  );
}

function applyLiveEdgeHistoryWindow(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensPulseHistoryEntry[],
  targetWindowCount: number,
): void {
  const trimmedEntries =
    entries.length > targetWindowCount ? entries.slice(-targetWindowCount) : entries.slice();
  snapshot.transcript = trimmedEntries;
  snapshot.historyWindowEnd = snapshot.totalHistoryCount;
  snapshot.historyWindowStart = Math.max(0, snapshot.historyWindowEnd - trimmedEntries.length);
  snapshot.estimatedHistoryAfterWindowPx = 0;
  snapshot.estimatedHistoryBeforeWindowPx = Math.max(
    0,
    (snapshot.estimatedTotalHistoryHeightPx ?? 0) - sumEstimatedHistoryHeights(trimmedEntries),
  );
}

function reindexHistoryEntryMap(
  entryIndexById: Map<string, number>,
  entries: readonly LensPulseHistoryEntry[],
): void {
  entryIndexById.clear();
  entries.forEach((entry, index) => {
    entryIndexById.set(entry.entryId, index);
  });
}

function upsertSnapshotItems(
  current: readonly LensPulseSnapshotResponse['items'][number][],
  upserts: readonly LensPulseSnapshotResponse['items'][number][],
  removals: readonly string[],
): LensPulseSnapshotResponse['items'] {
  const next = new Map(current.map((item) => [item.itemId, cloneSnapshotItemSummary(item)]));

  for (const itemId of removals) {
    next.delete(itemId);
  }

  for (const item of upserts) {
    next.set(item.itemId, cloneSnapshotItemSummary(item));
  }

  return Array.from(next.values()).sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

function upsertSnapshotRequests(
  current: readonly LensPulseSnapshotResponse['requests'][number][],
  upserts: readonly LensPulseSnapshotResponse['requests'][number][],
  removals: readonly string[],
): LensPulseSnapshotResponse['requests'] {
  const next = new Map(
    current.map((request) => [request.requestId, cloneSnapshotRequestSummary(request)]),
  );

  for (const requestId of removals) {
    next.delete(requestId);
  }

  for (const request of upserts) {
    next.set(request.requestId, cloneSnapshotRequestSummary(request));
  }

  return Array.from(next.values()).sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

function upsertSnapshotNotices(
  current: readonly LensPulseSnapshotResponse['notices'][number][],
  upserts: readonly LensPulseSnapshotResponse['notices'][number][],
): LensPulseSnapshotResponse['notices'] {
  const next = new Map(
    current.map((notice) => [notice.eventId, cloneSnapshotRuntimeNotice(notice)]),
  );

  for (const notice of upserts) {
    next.set(notice.eventId, cloneSnapshotRuntimeNotice(notice));
  }

  return Array.from(next.values()).sort(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function cloneSnapshotHistoryEntry(entry: LensPulseHistoryEntry): LensPulseHistoryEntry {
  return {
    ...entry,
    attachments: cloneHistoryAttachments(entry.attachments),
  };
}

function sumEstimatedHistoryHeights(entries: readonly LensPulseHistoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + Math.max(0, entry.estimatedHeightPx ?? 0), 0);
}

function cloneSnapshotItemSummary(
  item: LensPulseSnapshotResponse['items'][number],
): LensPulseSnapshotResponse['items'][number] {
  return {
    ...item,
    turnId: item.turnId ?? null,
    title: item.title ?? null,
    detail: item.detail ?? null,
    attachments: cloneHistoryAttachments(item.attachments),
  };
}

function cloneSnapshotRequestSummary(
  request: LensPulseSnapshotResponse['requests'][number],
): LensPulseSnapshotResponse['requests'][number] {
  return {
    ...request,
    turnId: request.turnId ?? null,
    detail: request.detail ?? null,
    decision: request.decision ?? null,
    questions: request.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    answers: request.answers.map((answer) => ({
      questionId: answer.questionId,
      answers: [...answer.answers],
    })),
  };
}

function cloneSnapshotRuntimeNotice(
  notice: LensPulseSnapshotResponse['notices'][number],
): LensPulseSnapshotResponse['notices'][number] {
  return {
    ...notice,
    detail: notice.detail ?? null,
  };
}

function cloneSnapshotSessionSummary(
  session: LensPulseSnapshotResponse['session'],
): LensPulseSnapshotResponse['session'] {
  return {
    ...session,
    reason: session.reason ?? null,
    lastError: session.lastError ?? null,
    lastEventAt: session.lastEventAt ?? null,
  };
}

function cloneSnapshotThreadSummary(
  thread: LensPulseSnapshotResponse['thread'],
): LensPulseSnapshotResponse['thread'] {
  return {
    ...thread,
  };
}

function cloneSnapshotTurnSummary(
  turn: LensPulseSnapshotResponse['currentTurn'],
): LensPulseSnapshotResponse['currentTurn'] {
  return {
    ...turn,
    turnId: turn.turnId ?? null,
    model: turn.model ?? null,
    effort: turn.effort ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
  };
}

function cloneSnapshotQuickSettingsSummary(
  quickSettings: LensPulseSnapshotResponse['quickSettings'] | null | undefined,
): LensPulseSnapshotResponse['quickSettings'] {
  return {
    model: quickSettings?.model ?? null,
    effort: quickSettings?.effort ?? null,
    planMode: quickSettings?.planMode ?? 'off',
    permissionMode: quickSettings?.permissionMode ?? 'manual',
  };
}

function cloneSnapshotStreamsSummary(
  streams: LensPulseSnapshotResponse['streams'],
): LensPulseSnapshotResponse['streams'] {
  return {
    ...streams,
  };
}
