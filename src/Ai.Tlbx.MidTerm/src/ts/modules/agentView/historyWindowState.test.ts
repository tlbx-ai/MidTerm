import { afterEach, describe, expect, it, vi } from 'vitest';

const updateLensHistoryStreamWindow = vi.fn();

vi.mock('../../api/client', () => ({
  updateLensHistoryStreamWindow,
}));

describe('historyWindowState', () => {
  afterEach(() => {
    updateLensHistoryStreamWindow.mockReset();
  });

  it('ignores fetched history windows older than the current live sequence', async () => {
    const { applyFetchedLensHistoryWindow } = await import('./historyWindowState');

    const state = {
      snapshot: {
        latestSequence: 12,
        historyWindowStart: 0,
        historyWindowEnd: 2,
        history: [{ entryId: 'assistant:newer', order: 1, body: 'newer' }],
      },
      historyWindowStart: 0,
      historyWindowCount: 2,
      disconnectStream: vi.fn(),
    } as any;

    const applied = applyFetchedLensHistoryWindow('session-1', state, {
      latestSequence: 11,
      historyWindowStart: 0,
      historyWindowEnd: 1,
      history: [{ entryId: 'assistant:older', order: 1, body: 'older' }],
    } as any);

    expect(applied).toBe(false);
    expect(state.snapshot.latestSequence).toBe(12);
    expect(state.snapshot.history[0]?.entryId).toBe('assistant:newer');
    expect(updateLensHistoryStreamWindow).not.toHaveBeenCalled();
  });
});
