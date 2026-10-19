import { describe, expect, it } from 'vitest';
import type {
  AppServerControlHistorySnapshot,
  AppServerControlUsageSummary,
} from '../../api/types';
import { buildAppServerControlRuntimeStats } from './historyProcessing';

function snapshot(usage?: AppServerControlUsageSummary): AppServerControlHistorySnapshot {
  return {
    session: { state: 'ready', stateLabel: 'Ready', ...(usage ? { usage } : {}) },
    history: [],
    notices: [
      {
        eventId: 'old-text',
        type: 'thread.token-usage.updated',
        message: 'Codex context window updated.',
        detail: 'Used 9000 tokens, window 64000, last turn in/out 20/10',
        createdAt: '2026-10-17T00:00:00Z',
      },
    ],
  } as AppServerControlHistorySnapshot;
}

describe('structured provider usage', () => {
  it('uses typed native usage instead of conflicting diagnostic text and preserves unknown counters', () => {
    expect(
      buildAppServerControlRuntimeStats(
        snapshot({
          contextUsedTokens: 2345,
          contextWindowTokens: 128000,
          costAmount: 0.0123,
          costCurrency: 'EUR',
        }),
      ),
    ).toEqual({
      windowUsedTokens: 2345,
      windowTokenLimit: 128000,
      accumulatedInputTokens: null,
      accumulatedOutputTokens: null,
      primaryRateLimitUsedPercent: null,
      secondaryRateLimitUsedPercent: null,
      costAmount: 0.0123,
      costCurrency: 'EUR',
    });
  });

  it('keeps reported zero counters and zero cost distinct from missing values', () => {
    const stats = buildAppServerControlRuntimeStats(
      snapshot({
        contextUsedTokens: 0,
        contextWindowTokens: 128000,
        inputTokens: 0,
        outputTokens: 0,
        costAmount: 0,
        costCurrency: 'USD',
      }),
    );
    expect(stats?.accumulatedInputTokens).toBe(0);
    expect(stats?.accumulatedOutputTokens).toBe(0);
    expect(stats?.windowUsedTokens).toBe(0);
    expect(stats?.costAmount).toBe(0);
  });

  it('does not invent a currency for a cost without native currency metadata', () => {
    expect(
      buildAppServerControlRuntimeStats(
        snapshot({ contextUsedTokens: 1, contextWindowTokens: 2, costAmount: 0.01 }),
      ),
    ).not.toHaveProperty('costAmount');
  });

  it('still reads historical notices when persisted history predates structured usage', () => {
    expect(buildAppServerControlRuntimeStats(snapshot())).toMatchObject({
      windowUsedTokens: 9000,
      windowTokenLimit: 64000,
      accumulatedInputTokens: 20,
      accumulatedOutputTokens: 10,
    });
  });
});
