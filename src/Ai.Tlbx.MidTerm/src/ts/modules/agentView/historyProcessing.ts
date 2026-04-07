import { t } from '../i18n';
import type {
  LensPulseEvent,
  LensPulseHistoryEntry,
  LensPulseRequestSummary,
  LensPulseSnapshotResponse,
} from '../../api/client';
import type { LensAttachmentReference, LensPulseRuntimeNotice } from '../../api/types';
import {
  formatAbsoluteTime,
  historyLabel,
  normalizeSnapshotHistoryKind,
  prettify,
  toneFromState,
} from './activationHelpers';
import {
  hasInlineCommandPresentation,
  isCommandExecutionHistoryEntry,
  isCommandOutputHistoryEntry,
  normalizeHistoryItemType,
  parseCommandOutputBody,
} from './historyContent';
import type {
  HistoryKind,
  LensActivationIssue,
  LensHistoryEntry,
  LensRuntimeStatsSummary,
  PendingLensTurn,
  SessionLensViewState,
} from './types';

function lensText(key: string, fallback: string): string {
  const translated = t(key);
  return !translated || translated === key ? fallback : translated;
}

function normalizeComparableHistoryText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const BUSY_INDICATOR_ITEM_STATUSES = [
  'active',
  'in progress',
  'inprogress',
  'in_progress',
  'open',
  'running',
  'starting',
] as const;

const GENERIC_BUSY_INDICATOR_LABELS = new Set([
  '',
  'assistant',
  'assistant message',
  'command',
  'command execution',
  'command output',
  'plan',
  'reasoning',
  'request',
  'tool',
  'tool completed',
  'tool started',
  'user',
]);

const BUSY_INDICATOR_EXCLUDED_ITEM_TYPES = new Set([
  'assistant_message',
  'assistantmessage',
  'command_output',
  'file_change_output',
  'user_message',
  'usermessage',
]);

const BUSY_SWEEP_DURATION_MS = 1450;
const BUSY_SWEEP_CYCLE_MS = BUSY_SWEEP_DURATION_MS * 2;
const COMMAND_HISTORY_ITEM_TYPES = new Set([
  'command',
  'commandcall',
  'commandexecution',
  'commandoutput',
  'commandrun',
]);

export function cloneHistoryAttachments(
  attachments: readonly LensAttachmentReference[] | undefined,
): LensAttachmentReference[] {
  return attachments?.map((attachment) => ({ ...attachment })) ?? [];
}

export function buildLensHistoryEntries(
  snapshot: LensPulseSnapshotResponse,
  _events: LensPulseEvent[],
): LensHistoryEntry[] {
  const historyEntries = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
  if (historyEntries.length === 0) {
    return [];
  }

  return historyEntries
    .map((entry) => {
      const kind = normalizeSnapshotHistoryKind(entry.kind);
      const statusLabel = entry.streaming
        ? lensText('lens.status.streaming', 'Streaming')
        : prettify(entry.status || kind);
      const mapped: LensHistoryEntry = {
        id: entry.entryId,
        order: entry.order,
        kind,
        tone: toneFromState(entry.status),
        label: historyLabel(kind),
        title: entry.title || '',
        body: entry.body || '',
        meta:
          kind === 'diff' || isCommandExecutionSnapshotEntry(entry)
            ? ''
            : formatHistoryMeta(kind, statusLabel, entry.updatedAt),
        attachments: cloneHistoryAttachments(entry.attachments),
        live: entry.streaming,
        sourceItemId: entry.itemId ?? null,
        sourceTurnId: entry.turnId ?? null,
        sourceItemType: entry.itemType ?? null,
      };
      if (entry.requestId) {
        mapped.requestId = entry.requestId;
      }
      applyDirectCommandPresentation(mapped);
      if (hasInlineCommandPresentation(mapped)) {
        mapped.meta = '';
      }
      return mapped;
    })
    .filter((entry) => !isSuppressedLensRuntimeNoticeEntry(entry))
    .sort((left, right) => left.order - right.order)
    .reduce<LensHistoryEntry[]>(mergeCommandOutputHistoryEntries, [])
    .filter(
      (entry) =>
        entry.body.trim() ||
        (entry.commandText?.trim() ?? '').length > 0 ||
        (entry.attachments?.length ?? 0) > 0 ||
        entry.kind === 'request' ||
        entry.kind === 'system' ||
        entry.kind === 'notice',
    );
}

export function preservePersistentCommandEntries(
  entries: readonly LensHistoryEntry[],
  previousEntries: readonly LensHistoryEntry[],
  snapshot:
    | Pick<LensPulseSnapshotResponse, 'historyWindowEnd' | 'historyWindowStart'>
    | null
    | undefined,
): LensHistoryEntry[] {
  if (entries.length === 0 && previousEntries.length === 0) {
    return [];
  }

  const rememberedEntries = previousEntries.filter(isPersistentCommandEntry);
  if (rememberedEntries.length === 0) {
    return [...entries];
  }

  const rememberedByKey = new Map<string, LensHistoryEntry>();
  for (const entry of rememberedEntries) {
    for (const key of buildPersistentCommandKeys(entry)) {
      if (!rememberedByKey.has(key)) {
        rememberedByKey.set(key, entry);
      }
    }
  }

  const seenKeys = new Set<string>();
  const nextEntries = entries.map((entry) => {
    const remembered = resolveRememberedCommandEntry(entry, rememberedByKey);
    const merged = mergePersistentCommandEntry(entry, remembered);
    for (const key of buildPersistentCommandKeys(merged)) {
      seenKeys.add(key);
    }
    return merged;
  });

  for (const remembered of rememberedEntries) {
    const keys = buildPersistentCommandKeys(remembered);
    if (keys.some((key) => seenKeys.has(key))) {
      continue;
    }

    if (!shouldRetainMissingCommandEntry(remembered, snapshot)) {
      continue;
    }

    nextEntries.push(cloneLensHistoryEntry(remembered));
    for (const key of keys) {
      seenKeys.add(key);
    }
  }

  return nextEntries.sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
}

function isCommandExecutionSnapshotEntry(
  entry: Pick<LensPulseHistoryEntry, 'kind' | 'itemType'>,
): boolean {
  return (
    normalizeSnapshotHistoryKind(entry.kind) === 'tool' &&
    normalizeComparableHistoryText(entry.itemType ?? '').replace(/[_-]+/g, ' ') ===
      'command execution'
  );
}

function applyDirectCommandPresentation(entry: LensHistoryEntry): void {
  const commandPresentation = resolveCommandPresentation(entry);
  if (!commandPresentation) {
    return;
  }

  entry.commandText = commandPresentation.commandText;
  entry.commandOutputTail = commandPresentation.commandOutputTail;
  entry.body = '';
}

function resolveCommandPresentation(
  entry: Pick<LensHistoryEntry, 'body' | 'commandOutputTail' | 'commandText' | 'sourceItemType'>,
): { commandText: string; commandOutputTail: string[] } | null {
  const normalizedType = normalizeHistoryItemType(entry.sourceItemType);
  if (normalizedType === 'commandexecution') {
    const commandText = (entry.commandText ?? entry.body).trim();
    return commandText ? { commandText, commandOutputTail: entry.commandOutputTail ?? [] } : null;
  }

  if (normalizedType !== 'commandoutput') {
    return null;
  }

  if ((entry.commandText?.trim() ?? '').length > 0) {
    const commandText = entry.commandText?.trim() ?? '';
    return {
      commandText,
      commandOutputTail: entry.commandOutputTail ?? [],
    };
  }

  return parseCommandOutputBody(entry.body);
}

function isPersistentCommandEntry(entry: LensHistoryEntry): boolean {
  if (entry.kind !== 'tool') {
    return false;
  }

  if (hasInlineCommandPresentation(entry)) {
    return true;
  }

  return COMMAND_HISTORY_ITEM_TYPES.has(normalizeHistoryItemType(entry.sourceItemType));
}

function buildPersistentCommandKeys(entry: LensHistoryEntry): string[] {
  if (!isPersistentCommandEntry(entry)) {
    return [];
  }

  return buildCommandLookupKeys(entry);
}

function buildCommandLookupKeys(entry: LensHistoryEntry): string[] {
  const keys = new Set<string>();
  const commandText = (entry.commandText ?? '').trim();
  const normalizedCommandText = normalizeComparableHistoryText(commandText);
  if (entry.id.trim()) {
    keys.add(`id:${entry.id}`);
  }
  if ((entry.sourceItemId ?? '').trim()) {
    keys.add(`item:${entry.sourceItemId}`);
  }
  if ((entry.sourceTurnId ?? '').trim() && normalizedCommandText) {
    keys.add(`turncmd:${entry.sourceTurnId}:${normalizedCommandText}`);
  }
  if (normalizedCommandText) {
    keys.add(`ordercmd:${Math.floor(entry.order)}:${normalizedCommandText}`);
  }
  return [...keys];
}

function resolveRememberedCommandEntry(
  entry: LensHistoryEntry,
  rememberedByKey: ReadonlyMap<string, LensHistoryEntry>,
): LensHistoryEntry | null {
  if (entry.kind !== 'tool') {
    return null;
  }

  for (const key of buildCommandLookupKeys(entry)) {
    const remembered = rememberedByKey.get(key);
    if (remembered) {
      return remembered;
    }
  }

  return null;
}

function mergePersistentCommandEntry(
  entry: LensHistoryEntry,
  remembered: LensHistoryEntry | null,
): LensHistoryEntry {
  if (!remembered || entry.kind !== 'tool') {
    return entry;
  }

  const rememberedCommandText = (remembered.commandText ?? '').trim();
  const nextCommandText = (entry.commandText ?? '').trim() || rememberedCommandText;
  const nextCommandOutputTail = resolveMergedCommandOutputTail(entry, remembered);
  const shouldForceCommandPresentation = shouldForcePersistentCommandPresentation(
    entry,
    remembered,
    nextCommandText,
    nextCommandOutputTail,
  );

  if (!shouldForceCommandPresentation) {
    return entry;
  }

  return {
    ...entry,
    body: '',
    meta: '',
    commandText: nextCommandText || null,
    commandOutputTail: nextCommandOutputTail,
  };
}

function resolveMergedCommandOutputTail(
  entry: LensHistoryEntry,
  remembered: LensHistoryEntry,
): string[] {
  return (entry.commandOutputTail?.length ?? 0) > 0
    ? [...(entry.commandOutputTail ?? [])]
    : [...(remembered.commandOutputTail ?? [])];
}

function shouldForcePersistentCommandPresentation(
  entry: LensHistoryEntry,
  remembered: LensHistoryEntry,
  nextCommandText: string,
  nextCommandOutputTail: readonly string[],
): boolean {
  if (nextCommandText.length > 0 || nextCommandOutputTail.length > 0) {
    return true;
  }

  return isPersistentCommandEntry(entry) && isPersistentCommandEntry(remembered);
}

function shouldRetainMissingCommandEntry(
  entry: LensHistoryEntry,
  snapshot:
    | Pick<LensPulseSnapshotResponse, 'historyWindowEnd' | 'historyWindowStart'>
    | null
    | undefined,
): boolean {
  if (!snapshot) {
    return true;
  }

  const absoluteIndex = Math.max(0, Math.floor(entry.order) - 1);
  return absoluteIndex >= snapshot.historyWindowStart && absoluteIndex < snapshot.historyWindowEnd;
}

function cloneLensHistoryEntry(entry: LensHistoryEntry): LensHistoryEntry {
  const cloned: LensHistoryEntry = {
    ...entry,
    attachments: cloneHistoryAttachments(entry.attachments),
    commandOutputTail: [...(entry.commandOutputTail ?? [])],
  };
  if (entry.actions) {
    cloned.actions = entry.actions.map((action) => ({ ...action }));
  }
  return cloned;
}

function findMatchingCommandExecutionIndex(
  mergedEntries: readonly LensHistoryEntry[],
  entry: LensHistoryEntry,
): number {
  for (let index = mergedEntries.length - 1; index >= 0; index -= 1) {
    const candidate = mergedEntries[index];
    if (!candidate || !isCommandExecutionHistoryEntry(candidate)) {
      continue;
    }

    const sameSourceItem =
      candidate.sourceItemId && entry.sourceItemId && candidate.sourceItemId === entry.sourceItemId;
    if (sameSourceItem || candidate.id === entry.id) {
      return index;
    }
  }

  const previousEntry = mergedEntries[mergedEntries.length - 1];
  return previousEntry && isCommandExecutionHistoryEntry(previousEntry)
    ? mergedEntries.length - 1
    : -1;
}

function mergeCommandOutputHistoryEntries(
  mergedEntries: LensHistoryEntry[],
  entry: LensHistoryEntry,
): LensHistoryEntry[] {
  if (!isCommandOutputHistoryEntry(entry)) {
    mergedEntries.push(entry);
    return mergedEntries;
  }

  const targetIndex = findMatchingCommandExecutionIndex(mergedEntries, entry);
  if (targetIndex < 0) {
    mergedEntries.push(entry);
    return mergedEntries;
  }

  const targetEntry = mergedEntries[targetIndex];
  const commandPresentation = resolveCommandPresentation(entry);
  if (!targetEntry || !commandPresentation) {
    return mergedEntries;
  }

  mergedEntries[targetIndex] = {
    ...targetEntry,
    body: '',
    commandText: targetEntry.commandText ?? commandPresentation.commandText,
    commandOutputTail: commandPresentation.commandOutputTail,
  };
  return mergedEntries;
}

export function isSuppressedLensRuntimeNoticeEntry(
  entry: Pick<LensHistoryEntry, 'kind' | 'title' | 'body'>,
): boolean {
  if (!['system', 'notice'].includes(normalizeSnapshotHistoryKind(entry.kind))) {
    return false;
  }

  const title = normalizeComparableHistoryText(entry.title);
  const body = normalizeComparableHistoryText(entry.body);
  const contextMarker = normalizeComparableHistoryText('Codex context window updated.');
  const rateLimitMarker = normalizeComparableHistoryText('Codex rate limits updated.');
  return (
    title === contextMarker ||
    body === contextMarker ||
    title === rateLimitMarker ||
    body === rateLimitMarker ||
    body.includes(normalizeComparableHistoryText('last turn in/out')) ||
    body.includes('"ratelimits"') ||
    body.includes('"usedpercent"')
  );
}

export function buildLensRuntimeStats(
  snapshot: LensPulseSnapshotResponse,
): LensRuntimeStatsSummary | null {
  const stats: LensRuntimeStatsSummary = {
    windowUsedTokens: null,
    windowTokenLimit: null,
    accumulatedInputTokens: 0,
    accumulatedOutputTokens: 0,
    primaryRateLimitUsedPercent: null,
    secondaryRateLimitUsedPercent: null,
  };
  let hasStats = false;
  const sources =
    snapshot.notices.length > 0
      ? snapshot.notices
      : snapshot.transcript
          .filter((entry) =>
            isSuppressedLensRuntimeNoticeEntry({
              kind: normalizeSnapshotHistoryKind(entry.kind),
              title: entry.title ?? '',
              body: entry.body,
            }),
          )
          .map<LensPulseRuntimeNotice>((entry) => ({
            eventId: entry.entryId,
            type: normalizeSnapshotHistoryKind(entry.kind),
            message: entry.title ?? '',
            detail: entry.body,
            createdAt: entry.updatedAt,
          }));

  for (const notice of sources) {
    const contextWindow = parseCodexContextWindowNotice(notice);
    if (contextWindow) {
      stats.windowUsedTokens = contextWindow.usedTokens;
      stats.windowTokenLimit = contextWindow.windowTokens;
      stats.accumulatedInputTokens += contextWindow.lastTurnInputTokens;
      stats.accumulatedOutputTokens += contextWindow.lastTurnOutputTokens;
      hasStats = true;
      continue;
    }

    const rateLimits = parseCodexRateLimitNotice(notice);
    if (rateLimits) {
      stats.primaryRateLimitUsedPercent = rateLimits.primaryUsedPercent;
      stats.secondaryRateLimitUsedPercent = rateLimits.secondaryUsedPercent;
      hasStats = true;
    }
  }

  return hasStats ? stats : null;
}

function parseCodexContextWindowNotice(
  notice: Pick<LensPulseRuntimeNotice, 'message' | 'detail'>,
): {
  usedTokens: number;
  windowTokens: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
} | null {
  const message = normalizeComparableHistoryText(notice.message);
  const detail = notice.detail ?? '';
  if (
    message !== normalizeComparableHistoryText('Codex context window updated.') &&
    !normalizeComparableHistoryText(detail).includes(
      normalizeComparableHistoryText('last turn in/out'),
    )
  ) {
    return null;
  }

  const match = detail.match(
    /Used\s+(\d+)\s+tokens,\s+window\s+(\d+),\s+last turn in\/out\s+(\d+)\/(\d+)/i,
  );
  if (!match) {
    return null;
  }

  const [, usedTokensText, windowTokensText, inputTokensText, outputTokensText] = match;
  if (!usedTokensText || !windowTokensText || !inputTokensText || !outputTokensText) {
    return null;
  }

  return {
    usedTokens: Number.parseInt(usedTokensText, 10),
    windowTokens: Number.parseInt(windowTokensText, 10),
    lastTurnInputTokens: Number.parseInt(inputTokensText, 10),
    lastTurnOutputTokens: Number.parseInt(outputTokensText, 10),
  };
}

function parseCodexRateLimitNotice(
  notice: Pick<LensPulseRuntimeNotice, 'message' | 'detail'>,
): { primaryUsedPercent: number | null; secondaryUsedPercent: number | null } | null {
  if (
    normalizeComparableHistoryText(notice.message) !==
      normalizeComparableHistoryText('Codex rate limits updated.') ||
    !notice.detail
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(notice.detail) as {
      rateLimits?: {
        primary?: { usedPercent?: number | null };
        secondary?: { usedPercent?: number | null };
      };
    };
    return {
      primaryUsedPercent:
        typeof parsed.rateLimits?.primary?.usedPercent === 'number'
          ? parsed.rateLimits.primary.usedPercent
          : null,
      secondaryUsedPercent:
        typeof parsed.rateLimits?.secondary?.usedPercent === 'number'
          ? parsed.rateLimits.secondary.usedPercent
          : null,
    };
  } catch {
    return null;
  }
}

export function applyOptimisticLensTurns(
  snapshot: LensPulseSnapshotResponse,
  entries: readonly LensHistoryEntry[],
  optimisticTurns: readonly PendingLensTurn[],
): { entries: LensHistoryEntry[]; optimisticTurns: PendingLensTurn[] } {
  if (optimisticTurns.length === 0) {
    return { entries: [...entries], optimisticTurns: [] };
  }

  const optimisticEntries = [...entries];
  const remainingTurns: PendingLensTurn[] = [];
  let nextOrder =
    optimisticEntries.reduce((maxOrder, entry) => Math.max(maxOrder, entry.order), 0) + 1;

  for (const turn of optimisticTurns) {
    const userCommitted =
      turn.turnId !== null && optimisticEntries.some((entry) => entry.id === `user:${turn.turnId}`);
    const assistantCommitted =
      (turn.turnId !== null &&
        optimisticEntries.some((entry) => entry.id === `assistant:${turn.turnId}`)) ||
      (turn.turnId !== null &&
        snapshot.currentTurn.turnId === turn.turnId &&
        Boolean(snapshot.streams.assistantText.trim()));

    if (!userCommitted) {
      optimisticEntries.push({
        id: `optimistic-user:${turn.optimisticId}`,
        order: nextOrder++,
        kind: 'user',
        tone: 'info',
        label: historyLabel('user'),
        title: '',
        body: turn.text,
        meta: formatHistoryMeta(
          'user',
          turn.status === 'submitted' ? 'Sending' : 'Sent',
          turn.submittedAt,
        ),
        attachments: cloneHistoryAttachments(turn.attachments),
        pending: turn.status === 'submitted',
      });
    }

    if (!assistantCommitted) {
      optimisticEntries.push({
        id: `optimistic-assistant:${turn.optimisticId}`,
        order: nextOrder++,
        kind: 'assistant',
        tone: 'info',
        label: historyLabel('assistant'),
        title: '',
        body: turn.status === 'submitted' ? 'Starting…' : 'Thinking…',
        meta: formatHistoryMeta(
          'assistant',
          turn.status === 'submitted' ? 'Starting' : 'Running',
          turn.submittedAt,
        ),
        live: true,
        pending: turn.status === 'submitted',
      });
    }

    if (!userCommitted || !assistantCommitted) {
      remainingTurns.push(turn);
    }
  }

  return {
    entries: optimisticEntries.sort((left, right) => left.order - right.order),
    optimisticTurns: remainingTurns,
  };
}

export function withInlineLensStatus(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
  streamConnected: boolean,
): LensHistoryEntry[] {
  const hasConversation = entries.some((entry) =>
    ['user', 'assistant', 'tool', 'request', 'plan', 'diff'].includes(entry.kind),
  );
  const statusBody =
    snapshot.session.lastError?.trim() ||
    snapshot.session.reason?.trim() ||
    (streamConnected
      ? lensText(
          'lens.status.connectedWaiting',
          'Lens is connected to MidTerm and waiting for history content.',
        )
      : lensText('lens.status.reconnecting', 'Lens is reconnecting to MidTerm.'));

  if ((!statusBody || hasConversation) && !snapshot.session.lastError) {
    return entries;
  }

  return [
    {
      id: 'midterm-status',
      order: Number.MIN_SAFE_INTEGER,
      kind: snapshot.session.lastError ? 'notice' : 'system',
      tone: snapshot.session.lastError ? 'attention' : streamConnected ? 'positive' : 'warning',
      label: lensText('lens.label.midterm', 'MidTerm'),
      title: '',
      body: statusBody,
      meta: streamConnected ? '' : lensText('lens.status.connecting', 'Connecting'),
    },
    ...entries,
  ];
}

export function withLiveAssistantState(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
): LensHistoryEntry[] {
  if (snapshot.currentTurn.state !== 'running' && snapshot.currentTurn.state !== 'in_progress') {
    return entries;
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.kind !== 'assistant') {
      continue;
    }

    return entries.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, live: true } : candidate,
    );
  }

  return entries;
}

export function withTrailingBusyIndicator(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
  requests: readonly LensPulseRequestSummary[],
): LensHistoryEntry[] {
  const currentTurnState = (snapshot.currentTurn.state || '').toLowerCase();
  const sessionState = (snapshot.session.state || '').toLowerCase();
  if (
    requests.some((request) => request.state === 'open') ||
    !(
      currentTurnState === 'running' ||
      currentTurnState === 'in_progress' ||
      (currentTurnState.length === 0 && (sessionState === 'starting' || sessionState === 'running'))
    )
  ) {
    return entries.filter((entry) => !entry.busyIndicator);
  }

  const nextEntries = entries.filter((entry) => !entry.busyIndicator);
  const lastOrder = nextEntries.reduce((maxOrder, entry) => Math.max(maxOrder, entry.order), 0);
  nextEntries.push({
    id: `busy-indicator:${snapshot.currentTurn.turnId ?? snapshot.session.lastEventAt ?? 'current'}`,
    order: lastOrder + 1,
    kind: 'assistant',
    tone: 'info',
    label: historyLabel('assistant'),
    title: '',
    body: resolveBusyIndicatorLabelFromSnapshotItems(snapshot),
    meta: '',
    busyIndicator: true,
    busyElapsedText: formatLensTurnDuration(resolveBusyIndicatorElapsedMs(snapshot)),
    busyAnimationOffsetMs: resolveBusyIndicatorAnimationOffsetMs(snapshot),
  });
  return nextEntries;
}

function resolveBusyIndicatorLabelFromSnapshotItems(snapshot: LensPulseSnapshotResponse): string {
  const currentTurnId = snapshot.currentTurn.turnId ?? null;
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) {
      continue;
    }

    if (!isBusyIndicatorItemCandidate(item, currentTurnId)) {
      continue;
    }

    const label = resolveBusyIndicatorLabelFromItem(item);
    if (label) {
      return label;
    }
  }

  return lensText('lens.status.working', 'Working');
}

function isBusyIndicatorItemCandidate(item: unknown, currentTurnId: string | null): boolean {
  if (typeof item !== 'object' || item === null) {
    return false;
  }

  const candidate = item as {
    itemType?: unknown;
    turnId?: unknown;
    status?: unknown;
  };
  const itemTurnId = typeof candidate.turnId === 'string' ? candidate.turnId : null;
  if (currentTurnId && itemTurnId && itemTurnId !== currentTurnId) {
    return false;
  }

  const normalizedItemType = normalizeBusyIndicatorItemType(candidate.itemType);
  if (BUSY_INDICATOR_EXCLUDED_ITEM_TYPES.has(normalizedItemType)) {
    return false;
  }

  const status = normalizeComparableHistoryText(
    typeof candidate.status === 'string' ? candidate.status : '',
  );
  return BUSY_INDICATOR_ITEM_STATUSES.some((busyStatus) => status.includes(busyStatus));
}

function normalizeBusyIndicatorItemType(itemType: unknown): string {
  return typeof itemType === 'string'
    ? itemType
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : '';
}

function resolveBusyIndicatorLabelFromItem(item: unknown): string {
  if (typeof item !== 'object' || item === null) {
    return '';
  }

  const candidate = item as {
    detail?: unknown;
    title?: unknown;
    itemType?: unknown;
  };
  const detail = typeof candidate.detail === 'string' ? candidate.detail.trim() : '';
  if (detail) {
    return detail;
  }

  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  const normalizedTitle = normalizeComparableHistoryText(title);
  const normalizedItemType = normalizeComparableHistoryText(
    typeof candidate.itemType === 'string' ? prettify(candidate.itemType) : '',
  );
  return title &&
    !GENERIC_BUSY_INDICATOR_LABELS.has(normalizedTitle) &&
    normalizedTitle !== normalizedItemType
    ? title
    : '';
}

function resolveBusyIndicatorElapsedMs(snapshot: LensPulseSnapshotResponse): number | null {
  const startedAt = snapshot.currentTurn.startedAt ?? null;
  if (!startedAt) {
    return null;
  }

  const startMs = Date.parse(startedAt);
  return Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : null;
}

function resolveBusyIndicatorAnimationOffsetMs(snapshot: LensPulseSnapshotResponse): number {
  const elapsedMs = resolveBusyIndicatorElapsedMs(snapshot);
  if (elapsedMs === null) {
    return 0;
  }

  return elapsedMs % BUSY_SWEEP_CYCLE_MS;
}

function maybeRememberCompletedTurnDuration(
  snapshot: LensPulseSnapshotResponse,
  state: SessionLensViewState,
): void {
  const turnId = snapshot.currentTurn.turnId ?? null;
  const startedAt = snapshot.currentTurn.startedAt ?? null;
  const completedAt = snapshot.currentTurn.completedAt || snapshot.generatedAt;
  const currentTurnState = normalizeComparableHistoryText(snapshot.currentTurn.state || '');
  if (
    !turnId ||
    !startedAt ||
    !completedAt ||
    state.completedTurnDurationEntries.has(turnId) ||
    ['running', 'in progress'].includes(currentTurnState)
  ) {
    return;
  }

  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }

  state.completedTurnDurationEntries.set(turnId, {
    id: `turn-duration:${turnId}`,
    order: Number.MAX_SAFE_INTEGER,
    kind: 'system',
    tone: 'info',
    label: '',
    title: '',
    body: `(Turn took ${formatLensTurnDuration(durationMs)})`,
    meta: '',
    sourceTurnId: turnId,
    turnDurationNote: true,
  });
}

function pruneCompletedTurnDurationEntries(state: SessionLensViewState): void {
  const turnIds = [...state.completedTurnDurationEntries.keys()];
  for (const staleTurnId of turnIds.slice(0, Math.max(0, turnIds.length - 64))) {
    state.completedTurnDurationEntries.delete(staleTurnId);
  }
}

function appendTurnDurationEntries(
  entries: readonly LensHistoryEntry[],
  state: SessionLensViewState,
): LensHistoryEntry[] {
  if (state.completedTurnDurationEntries.size === 0) {
    return [...entries];
  }

  const nextEntries = [...entries];
  for (const durationEntry of state.completedTurnDurationEntries.values()) {
    const matchingEntries = entries.filter(
      (entry) => !durationEntry.sourceTurnId || entry.sourceTurnId === durationEntry.sourceTurnId,
    );
    if (matchingEntries.length === 0) {
      continue;
    }

    nextEntries.push({
      ...durationEntry,
      order:
        matchingEntries.reduce(
          (maxOrder, entry) => Math.max(maxOrder, entry.order),
          Number.MIN_SAFE_INTEGER,
        ) + 0.01,
    });
  }

  return nextEntries.sort((left, right) => left.order - right.order);
}

export function withTurnDurationNotes(
  snapshot: LensPulseSnapshotResponse,
  entries: LensHistoryEntry[],
  state: SessionLensViewState,
): LensHistoryEntry[] {
  maybeRememberCompletedTurnDuration(snapshot, state);
  pruneCompletedTurnDurationEntries(state);
  return appendTurnDurationEntries(entries, state);
}

export function syncBusyIndicatorTicker(args: {
  snapshot: LensPulseSnapshotResponse;
  state: SessionLensViewState;
  entries: readonly LensHistoryEntry[];
  renderCurrentAgentView: (sessionId: string, options?: { immediate?: boolean }) => void;
}): void {
  const { snapshot, state, entries, renderCurrentAgentView } = args;
  if (!entries.some((entry) => entry.busyIndicator)) {
    if (state.busyIndicatorTickHandle !== null) {
      window.clearTimeout(state.busyIndicatorTickHandle);
      state.busyIndicatorTickHandle = null;
    }
    return;
  }

  if (state.busyIndicatorTickHandle !== null) {
    return;
  }

  state.busyIndicatorTickHandle = window.setTimeout(() => {
    state.busyIndicatorTickHandle = null;
    renderCurrentAgentView(snapshot.sessionId, { immediate: true });
  }, 1000);
}

export function withActivationIssueNotice(
  entries: LensHistoryEntry[],
  issue: LensActivationIssue | null,
): LensHistoryEntry[] {
  if (!issue) {
    return entries;
  }

  return [
    {
      id: `lens-issue:${issue.kind}`,
      order: Number.MIN_SAFE_INTEGER,
      kind: issue.tone === 'attention' ? 'notice' : 'system',
      tone: issue.tone,
      label: lensText('lens.label.midterm', 'MidTerm'),
      title: issue.title,
      body: issue.body,
      meta: issue.meta,
      actions: issue.actions,
    },
    ...entries,
  ];
}

export function buildActivationHistoryEntries(state: SessionLensViewState): LensHistoryEntry[] {
  if (state.activationTrace.length === 0) {
    return [
      {
        id: 'activation:pending',
        order: 0,
        kind: 'system',
        tone: state.activationState === 'failed' ? 'attention' : 'warning',
        label: lensText('lens.label.midterm', 'MidTerm'),
        title: '',
        body: state.activationDetail || 'Waiting for Lens boot steps…',
        meta:
          state.activationState === 'failed'
            ? lensText('lens.status.failed', 'Failed')
            : lensText('lens.status.connecting', 'Connecting'),
      },
    ];
  }

  const traceEntries =
    state.activationIssue?.kind === 'busy-terminal-turn' ||
    state.activationIssue?.kind === 'missing-resume-id' ||
    state.activationIssue?.kind === 'shell-recovery-failed' ||
    state.activationIssue?.kind === 'native-runtime-unavailable'
      ? state.activationTrace.filter((entry) => entry.tone !== 'attention').slice(-2)
      : state.activationTrace;

  return traceEntries.map((entry, index) => ({
    id: `activation:${index}`,
    order: index,
    kind: entry.tone === 'attention' ? ('notice' as const) : ('system' as const),
    tone: entry.tone,
    label: lensText('lens.label.midterm', 'MidTerm'),
    title: '',
    body: entry.detail,
    meta: entry.meta,
  }));
}

export function formatHistoryMeta(kind: HistoryKind, statusLabel: string, value: string): string {
  void kind;
  void statusLabel;
  return formatAbsoluteTime(value);
}

export function shouldHideStatusInMeta(kind: HistoryKind, statusLabel: string): boolean {
  void kind;
  void statusLabel;
  return true;
}

export function formatLensTurnDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return '0s';
  }

  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (totalMinutes > 0) {
    return `${totalMinutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
