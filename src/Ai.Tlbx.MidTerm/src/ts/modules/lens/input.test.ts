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
      quickSettings: {
        model: null,
        effort: null,
        planMode: 'off',
        permissionMode: 'manual',
      },
    });

    const { submitLensTurn, LENS_TURN_SUBMITTED_EVENT, LENS_TURN_ACCEPTED_EVENT } = await import(
      './input'
    );

    await submitLensTurn('s1', {
      text: 'Inspect the diff.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    expect(sendLensTurn).toHaveBeenCalledWith('s1', {
      text: 'Inspect the diff.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    expect(dispatchEvent.mock.calls.map((call) => call[0]?.type)).toEqual(
      expect.arrayContaining([LENS_TURN_SUBMITTED_EVENT, LENS_TURN_ACCEPTED_EVENT]),
    );
    vi.unstubAllGlobals();
  });
});
