import type { LensHistoryDelta, LensHistoryItem, LensHistorySnapshot } from '../../api/client';
import type { LensAttachmentReference } from '../../api/types';
import type { SessionLensViewState } from './types';

function cloneHistoryAttachments(
  attachments: readonly LensAttachmentReference[] | undefined,
): LensAttachmentReference[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

export function applyLensHistoryWindowState(
  state: SessionLensViewState,
  snapshot: LensHistorySnapshot,
): void {
  const windowStart =
    typeof snapshot.historyWindowStart === 'number' ? snapshot.historyWindowStart : 0;
  const windowEnd =
    typeof snapshot.historyWindowEnd === 'number'
      ? snapshot.historyWindowEnd
      : windowStart + snapshot.history.length;
  const windowSize = Math.max(0, windowEnd - windowStart);
  state.historyWindowStart = windowStart;
  state.historyWindowCount = windowSize;
  state.historyWindowTargetCount = Math.max(1, state.historyWindowTargetCount || 0, windowSize);
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
    snapshot.history.length > targetWindowCount
      ? snapshot.history.slice(-targetWindowCount)
      : snapshot.history.slice();
  const historyCount = Math.max(snapshot.historyCount, retainedEntries.length);

  snapshot.history = retainedEntries;
  snapshot.historyCount = historyCount;
  snapshot.historyWindowEnd = historyCount;
  snapshot.historyWindowStart = Math.max(0, historyCount - retainedEntries.length);
  snapshot.hasOlderHistory = snapshot.historyWindowStart > 0;
  snapshot.hasNewerHistory = false;
  state.historyWindowStart = snapshot.historyWindowStart;
  state.historyWindowCount = retainedEntries.length;
  state.historyWindowTargetCount = Math.max(1, targetWindowCount);
}

export function applyCanonicalLensDelta(
  state: SessionLensViewState,
  delta: LensHistoryDelta,
): boolean {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return false;
  }

  const previousHistoryCount = snapshot.historyCount;
  snapshot.provider = delta.provider || snapshot.provider;
  snapshot.generatedAt = delta.generatedAt;
  snapshot.latestSequence = Math.max(snapshot.latestSequence, delta.latestSequence);
  snapshot.historyCount = Math.max(delta.historyCount, snapshot.historyCount);
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
    previousHistoryCount,
    delta.historyUpserts,
    delta.historyRemovals,
  );
}

function applyHistoryWindowDelta(
  state: SessionLensViewState,
  snapshot: LensHistorySnapshot,
  previousHistoryCount: number,
  upserts: readonly LensHistoryItem[],
  removals: readonly string[],
): boolean {
  const currentWindowStart = snapshot.historyWindowStart;
  const currentWindowEnd = snapshot.historyWindowEnd;
  const wasLiveEdge = state.historyAutoScrollPinned && currentWindowEnd >= previousHistoryCount;
  const nextEntries = snapshot.history.map(cloneSnapshotHistoryEntry);
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
  const targetWindowCount = Math.max(
    1,
    state.historyWindowTargetCount || 0,
    state.historyWindowCount || 0,
    snapshot.history.length || 1,
  );
  applyHistoryWindowEntries(
    snapshot,
    nextEntries,
    wasLiveEdge,
    currentWindowStart,
    currentWindowEnd,
    targetWindowCount,
  );

  snapshot.hasOlderHistory = snapshot.historyWindowStart > 0;
  snapshot.hasNewerHistory = snapshot.historyWindowEnd < snapshot.historyCount;
  state.historyWindowStart = snapshot.historyWindowStart;
  state.historyWindowCount = snapshot.history.length;
  return requiresWindowRefresh;
}

function resolveHistoryWindowRefreshRequirement(
  wasLiveEdge: boolean,
  currentWindowStart: number,
  currentWindowEnd: number,
  upserts: readonly LensHistoryItem[],
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
  entries: LensHistoryItem[],
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
  entries: LensHistoryItem[],
  entryIndexById: Map<string, number>,
  upserts: readonly LensHistoryItem[],
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
  snapshot: LensHistorySnapshot,
  entries: readonly LensHistoryItem[],
  wasLiveEdge: boolean,
  currentWindowStart: number,
  currentWindowEnd: number,
  targetWindowCount: number,
): void {
  if (wasLiveEdge) {
    applyLiveEdgeHistoryWindow(snapshot, entries, targetWindowCount);
    return;
  }

  snapshot.history = entries.filter((entry) => {
    const absoluteIndex = Math.max(0, entry.order - 1);
    return absoluteIndex >= currentWindowStart && absoluteIndex < currentWindowEnd;
  });
  snapshot.historyWindowStart = currentWindowStart;
  snapshot.historyWindowEnd = snapshot.historyWindowStart + snapshot.history.length;
}

function applyLiveEdgeHistoryWindow(
  snapshot: LensHistorySnapshot,
  entries: readonly LensHistoryItem[],
  targetWindowCount: number,
): void {
  const trimmedEntries =
    entries.length > targetWindowCount ? entries.slice(-targetWindowCount) : entries.slice();
  snapshot.history = trimmedEntries;
  snapshot.historyWindowEnd = snapshot.historyCount;
  snapshot.historyWindowStart = Math.max(0, snapshot.historyCount - trimmedEntries.length);
}

function reindexHistoryEntryMap(
  entryIndexById: Map<string, number>,
  entries: readonly LensHistoryItem[],
): void {
  entryIndexById.clear();
  entries.forEach((entry, index) => {
    entryIndexById.set(entry.entryId, index);
  });
}

function upsertSnapshotItems(
  current: readonly LensHistorySnapshot['items'][number][],
  upserts: readonly LensHistorySnapshot['items'][number][],
  removals: readonly string[],
): LensHistorySnapshot['items'] {
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
  current: readonly LensHistorySnapshot['requests'][number][],
  upserts: readonly LensHistorySnapshot['requests'][number][],
  removals: readonly string[],
): LensHistorySnapshot['requests'] {
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
  current: readonly LensHistorySnapshot['notices'][number][],
  upserts: readonly LensHistorySnapshot['notices'][number][],
): LensHistorySnapshot['notices'] {
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

function cloneSnapshotHistoryEntry(entry: LensHistoryItem): LensHistoryItem {
  return {
    ...entry,
    attachments: cloneHistoryAttachments(entry.attachments),
    fileMentions: (entry.fileMentions ?? []).map((mention) => ({ ...mention })),
    imagePreviews: (entry.imagePreviews ?? []).map((preview) => ({ ...preview })),
  };
}

function cloneSnapshotItemSummary(
  item: LensHistorySnapshot['items'][number],
): LensHistorySnapshot['items'][number] {
  return {
    ...item,
    turnId: item.turnId ?? null,
    title: item.title ?? null,
    detail: item.detail ?? null,
    attachments: cloneHistoryAttachments(item.attachments),
  };
}

function cloneSnapshotRequestSummary(
  request: LensHistorySnapshot['requests'][number],
): LensHistorySnapshot['requests'][number] {
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
  notice: LensHistorySnapshot['notices'][number],
): LensHistorySnapshot['notices'][number] {
  return {
    ...notice,
    detail: notice.detail ?? null,
  };
}

function cloneSnapshotSessionSummary(
  session: LensHistorySnapshot['session'],
): LensHistorySnapshot['session'] {
  return {
    ...session,
    reason: session.reason ?? null,
    lastError: session.lastError ?? null,
    lastEventAt: session.lastEventAt ?? null,
  };
}

function cloneSnapshotThreadSummary(
  thread: LensHistorySnapshot['thread'],
): LensHistorySnapshot['thread'] {
  return {
    ...thread,
  };
}

function cloneSnapshotTurnSummary(
  turn: LensHistorySnapshot['currentTurn'],
): LensHistorySnapshot['currentTurn'] {
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
  quickSettings: LensHistorySnapshot['quickSettings'] | null | undefined,
): LensHistorySnapshot['quickSettings'] {
  return {
    model: quickSettings?.model ?? null,
    effort: quickSettings?.effort ?? null,
    planMode: quickSettings?.planMode ?? 'off',
    permissionMode: quickSettings?.permissionMode ?? 'manual',
  };
}

function cloneSnapshotStreamsSummary(
  streams: LensHistorySnapshot['streams'],
): LensHistorySnapshot['streams'] {
  return {
    ...streams,
  };
}
