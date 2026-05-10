import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppServerControlHistoryDelta,
  AppServerControlHistorySnapshot,
} from '../../api/client';
import {
  resetAppServerControlHistoryTrace,
  traceAppServerControlHistoryFetch,
  traceAppServerControlHistoryPush,
  traceAppServerControlHistoryScroll,
  traceAppServerControlHistoryShow,
} from './historyTrace';

function buildSnapshot(
  overrides: Partial<AppServerControlHistorySnapshot> = {},
): AppServerControlHistorySnapshot {
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

function buildDelta(
  overrides: Partial<AppServerControlHistoryDelta> = {},
): AppServerControlHistoryDelta {
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
    window.localStorage.setItem('midterm.appServerControlTrace', '1');
    resetAppServerControlHistoryTrace();
    consoleDebug.mockClear();
  });

  afterEach(() => {
    window.localStorage.removeItem('midterm.appServerControlTrace');
    resetAppServerControlHistoryTrace();
    vi.unstubAllGlobals();
  });

  it('logs compact fetch and push summaries', () => {
    traceAppServerControlHistoryFetch(
      'session-1',
      buildSnapshot({
        historyWindowStart: 0,
        historyWindowEnd: 20,
        historyCount: 23,
      }),
      'scroll',
    );
    traceAppServerControlHistoryPush(
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
      '[AppServerControlHistory session-] fetch #1-#20 scroll total 23',
    );
    expect(consoleDebug).toHaveBeenNthCalledWith(
      2,
      '[AppServerControlHistory session-] push +#21 seq 2 total 21',
    );
  });

  it('logs in-place history upserts as updates instead of fresh appends', () => {
    traceAppServerControlHistoryPush(
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
      '[AppServerControlHistory session-] push ~#20 seq 2 total 20',
    );
  });

  it('dedupes unchanged show logs and reports discards when the retained window shifts', () => {
    traceAppServerControlHistoryShow({
      sessionId: 'session-1',
      historyWindowStart: 0,
      historyWindowEnd: 20,
      historyCount: 23,
      visibleStart: 14,
      visibleEnd: 20,
      pinnedToBottom: true,
    });
    traceAppServerControlHistoryShow({
      sessionId: 'session-1',
      historyWindowStart: 0,
      historyWindowEnd: 20,
      historyCount: 23,
      visibleStart: 14,
      visibleEnd: 20,
      pinnedToBottom: true,
    });
    traceAppServerControlHistoryShow({
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
      '[AppServerControlHistory session-] show #1-#20 view #15-#20 bottom total 23',
    );
    expect(consoleDebug).toHaveBeenNthCalledWith(
      2,
      '[AppServerControlHistory session-] show #3-#23 view #3-#10 custom discard #1-#2',
    );
    expect(consoleDebug).toHaveBeenCalledTimes(2);
  });

  it('logs fast scroll diagnostics with viewport and retained window context', () => {
    traceAppServerControlHistoryScroll({
      sessionId: 'session-1',
      reason: 'fast-wheel',
      scrollTop: 4242.4,
      clientHeight: 640,
      scrollHeight: 18000,
      deltaYPx: -1280.7,
      historyWindowStart: 120,
      historyWindowEnd: 180,
      historyCount: 360,
    });

    expect(consoleDebug).toHaveBeenCalledWith(
      '[AppServerControlHistory session-] scroll fast-wheel top 4242 height 640/18000 dy -1281 #121-#180 total 360',
    );
  });
});
