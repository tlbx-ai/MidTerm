import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendLensTurn = vi.fn();

vi.mock('../../api/client', () => ({
  sendLensTurn,
}));

vi.mock('../sessionTabs', () => ({
  getActiveTab: vi.fn(() => 'agent'),
}));

describe('lens input', () => {
  beforeEach(() => {
    sendLensTurn.mockReset();
  });

  it('dispatches optimistic lifecycle events around Lens turn submission', async () => {
    const dispatchEvent = vi.fn(() => true);
    vi.stubGlobal('window', { dispatchEvent } as unknown as Window);
    vi.stubGlobal(
      'CustomEvent',
      class<T> {
        type: string;
        detail: T;

        constructor(type: string, init: CustomEventInit<T>) {
          this.type = type;
          this.detail = init.detail as T;
        }
      } as unknown as typeof CustomEvent,
    );
    sendLensTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      provider: 'codex',
      turnId: 'turn-1',
      threadId: 'thread-1',
      requestId: null,
      model: null,
      effort: null,
    });

    const { submitLensTurn, LENS_TURN_SUBMITTED_EVENT, LENS_TURN_ACCEPTED_EVENT } = await import(
      './input'
    );

    await submitLensTurn('s1', {
      text: 'Inspect the diff.',
      attachments: [],
    });

    expect(sendLensTurn).toHaveBeenCalledWith('s1', {
      text: 'Inspect the diff.',
      attachments: [],
    });
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls[0]?.[0]?.type).toBe(LENS_TURN_SUBMITTED_EVENT);
    expect(dispatchEvent.mock.calls[1]?.[0]?.type).toBe(LENS_TURN_ACCEPTED_EVENT);
    vi.unstubAllGlobals();
  });
});
