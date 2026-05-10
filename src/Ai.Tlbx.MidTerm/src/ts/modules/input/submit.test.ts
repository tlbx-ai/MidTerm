import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendInput = vi.fn();
const pasteToTerminal = vi.fn();
const isAppServerControlActiveSession = vi.fn<(sessionId: string | null | undefined) => boolean>();
const createAppServerControlTurnRequest = vi.fn(
  (text: string, attachments: unknown[] = [], sessionId?: string) => ({
    text,
    attachments,
    sessionId,
  }),
);
const submitQueuedAppServerControlTurn = vi.fn();

vi.mock('../comms', () => ({
  sendInput,
}));

vi.mock('../terminal', () => ({
  pasteToTerminal,
}));

vi.mock('../appServerControl/input', () => ({
  isAppServerControlActiveSession,
  createAppServerControlTurnRequest,
  submitQueuedAppServerControlTurn,
}));

describe('submitSessionText', () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendInput.mockReset();
    pasteToTerminal.mockReset();
    isAppServerControlActiveSession.mockReset();
    createAppServerControlTurnRequest.mockClear();
    submitQueuedAppServerControlTurn.mockReset();
  });

  it('submits AppServerControl sessions as a new user turn', async () => {
    isAppServerControlActiveSession.mockReturnValue(true);
    submitQueuedAppServerControlTurn.mockResolvedValue(undefined);

    const { submitSessionText } = await import('./submit');
    await submitSessionText('s1', 'Summarize the diff.');

    expect(createAppServerControlTurnRequest).toHaveBeenCalledWith('Summarize the diff.', [], 's1');
    expect(submitQueuedAppServerControlTurn).toHaveBeenCalledWith('s1', {
      text: 'Summarize the diff.',
      attachments: [],
      sessionId: 's1',
    });
    expect(pasteToTerminal).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('preserves paste-and-enter behavior for terminal sessions', async () => {
    vi.useFakeTimers();
    isAppServerControlActiveSession.mockReturnValue(false);
    pasteToTerminal.mockResolvedValue(undefined);

    const { submitSessionText } = await import('./submit');
    const result = submitSessionText('s2', 'git status');

    await Promise.resolve();
    expect(pasteToTerminal).toHaveBeenCalledWith('s2', 'git status');
    expect(sendInput).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await result;

    expect(sendInput).toHaveBeenCalledWith('s2', '\r');
    expect(submitQueuedAppServerControlTurn).not.toHaveBeenCalled();
  });
});
