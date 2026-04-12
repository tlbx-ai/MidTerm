import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LensHistoryDelta, LensHistorySnapshot } from '../../api/client';
import {
  resetLensHistoryTrace,
  traceLensHistoryFetch,
  traceLensHistoryPush,
  traceLensHistoryShow,
} from './historyTrace';

function buildSnapshot(overrides: Partial<LensHistorySnapshot> = {}): LensHistorySnapshot {
  return {
    sessionId: 'session-1',
    provider: 'codex',
    generatedAt: '2026-04-12T20:00:00Z',
    latestSequence: 1,
    historyCount: 20,
    historyWindowStart: 0,
    historyWindowEnd: 20,
    hasOlderHistory: false,
    hasNewerHistory: false,
    session: {
      state: 'running',
      stateLabel: 'Running',
      reason: null,
      lastError: null,
      lastEventAt: null,
    },
    thread: {
      threadId: 'thread-1',
      state: 'running',
      stateLabel: 'Running',
    },
    currentTurn: {
      turnId: 'turn-1',
      state: 'running',
      stateLabel: 'Running',
      model: null,
      effort: null,
      startedAt: null,
      completedAt: null,
    },
    quickSettings: {
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
    },
    streams: {
      assistantText: '',
      reasoningText: '',
      reasoningSummaryText: '',
      planText: '',
      commandOutput: '',
      fileChangeOutput: '',
      unifiedDiff: '',
    },
    history: [],
    items: [],
    requests: [],
    notices: [],
    ...overrides,
  };
}

function buildDelta(overrides: Partial<LensHistoryDelta> = {}): LensHistoryDelta {
  return {
    sessionId: 'session-1',
    provider: 'codex',
    generatedAt: '2026-04-12T20:00:00Z',
    latestSequence: 2,
    historyCount: 21,
    session: {
      state: 'running',
      stateLabel: 'Running',
      reason: null,
      lastError: null,
      lastEventAt: null,
    },
    thread: {
      threadId: 'thread-1',
      state: 'running',
      stateLabel: 'Running',
    },
    currentTurn: {
      turnId: 'turn-1',
      state: 'running',
      stateLabel: 'Running',
      model: null,
      effort: null,
      startedAt: null,
      completedAt: null,
    },
    quickSettings: {
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
    },
    streams: {
      assistantText: '',
      reasoningText: '',
      reasoningSummaryText: '',
      planText: '',
      commandOutput: '',
      fileChangeOutput: '',
      unifiedDiff: '',
    },
    historyUpserts: [],
    historyRemovals: [],
    itemUpserts: [],
    itemRemovals: [],
    requestUpserts: [],
    requestRemovals: [],
    noticeUpserts: [],
    ...overrides,
  };
}

describe('historyTrace', () => {
  const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
      location: {
        hostname: 'example.test',
      },
    });
    window.localStorage.setItem('midterm.lensTrace', '1');
    resetLensHistoryTrace();
    consoleDebug.mockClear();
  });

  afterEach(() => {
    window.localStorage.removeItem('midterm.lensTrace');
    resetLensHistoryTrace();
    vi.unstubAllGlobals();
  });

  it('logs compact fetch and push summaries', () => {
    traceLensHistoryFetch(
      'session-1',
      buildSnapshot({
        historyWindowStart: 0,
        historyWindowEnd: 20,
        historyCount: 23,
      }),
      'scroll',
    );
    traceLensHistoryPush(
      'session-1',
      buildDelta({
        historyUpserts: [
          {
            entryId: 'entry-21',
            order: 21,
            kind: 'assistant',
            status: 'completed',
            body: '',
            attachments: [],
            streaming: false,
            createdAt: '2026-04-12T20:00:00Z',
            updatedAt: '2026-04-12T20:00:00Z',
          },
        ],
      }),
      buildSnapshot(),
    );

    expect(consoleDebug).toHaveBeenNthCalledWith(
      1,
      '[LensHistory session-] fetch #1-#20 scroll total 23',
    );
    expect(consoleDebug).toHaveBeenNthCalledWith(
      2,
      '[LensHistory session-] push +#21 seq 2 total 21',
    );
  });

  it('logs in-place history upserts as updates instead of fresh appends', () => {
    traceLensHistoryPush(
      'session-1',
      buildDelta({
        historyCount: 20,
        historyUpserts: [
          {
            entryId: 'entry-20',
            order: 20,
            kind: 'assistant',
            status: 'streaming',
            body: 'updated',
            attachments: [],
            streaming: true,
            createdAt: '2026-04-12T20:00:00Z',
            updatedAt: '2026-04-12T20:00:01Z',
          },
        ],
      }),
      buildSnapshot({
        history: [
          {
            entryId: 'entry-20',
            order: 20,
            kind: 'assistant',
            status: 'streaming',
            body: 'previous',
            attachments: [],
            streaming: true,
            createdAt: '2026-04-12T20:00:00Z',
            updatedAt: '2026-04-12T20:00:00Z',
          },
        ],
      }),
    );

    expect(consoleDebug).toHaveBeenCalledWith(
      '[LensHistory session-] push ~#20 seq 2 total 20',
    );
  });

  it('dedupes unchanged show logs and reports discards when the retained window shifts', () => {
    traceLensHistoryShow({
      sessionId: 'session-1',
      historyWindowStart: 0,
      historyWindowEnd: 20,
      historyCount: 23,
      visibleStart: 14,
      visibleEnd: 20,
      pinnedToBottom: true,
    });
    traceLensHistoryShow({
      sessionId: 'session-1',
      historyWindowStart: 0,
      historyWindowEnd: 20,
      historyCount: 23,
      visibleStart: 14,
      visibleEnd: 20,
      pinnedToBottom: true,
    });
    traceLensHistoryShow({
      sessionId: 'session-1',
      historyWindowStart: 2,
      historyWindowEnd: 23,
      historyCount: 23,
      visibleStart: 2,
      visibleEnd: 10,
      pinnedToBottom: false,
    });

    expect(consoleDebug).toHaveBeenNthCalledWith(
      1,
      '[LensHistory session-] show #1-#20 view #15-#20 bottom total 23',
    );
    expect(consoleDebug).toHaveBeenNthCalledWith(
      2,
      '[LensHistory session-] show #3-#23 view #3-#10 custom discard #1-#2',
    );
    expect(consoleDebug).toHaveBeenCalledTimes(2);
  });
});
