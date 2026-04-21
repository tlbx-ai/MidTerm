import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendInput = vi.fn();
const pasteToTerminal = vi.fn();
const isLensActiveSession = vi.fn<(sessionId: string | null | undefined) => boolean>();
const createLensTurnRequest = vi.fn((text: string, attachments: unknown[] = [], sessionId?: string) => ({
  text,
  attachments,
  sessionId,
}));
const submitQueuedLensTurn = vi.fn();

vi.mock('../comms', () => ({
  sendInput,
}));

vi.mock('../terminal', () => ({
  pasteToTerminal,
}));

vi.mock('../lens/input', () => ({
  isLensActiveSession,
  createLensTurnRequest,
  submitQueuedLensTurn,
}));

describe('submitSessionText', () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendInput.mockReset();
    pasteToTerminal.mockReset();
    isLensActiveSession.mockReset();
    createLensTurnRequest.mockClear();
    submitQueuedLensTurn.mockReset();
  });

  it('submits Lens sessions as a new user turn', async () => {
    isLensActiveSession.mockReturnValue(true);
    submitQueuedLensTurn.mockResolvedValue(undefined);

    const { submitSessionText } = await import('./submit');
    await submitSessionText('s1', 'Summarize the diff.');

    expect(createLensTurnRequest).toHaveBeenCalledWith('Summarize the diff.', [], 's1');
    expect(submitQueuedLensTurn).toHaveBeenCalledWith('s1', {
      text: 'Summarize the diff.',
      attachments: [],
      sessionId: 's1',
    });
    expect(pasteToTerminal).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('preserves paste-and-enter behavior for terminal sessions', async () => {
    vi.useFakeTimers();
    isLensActiveSession.mockReturnValue(false);
    pasteToTerminal.mockResolvedValue(undefined);

    const { submitSessionText } = await import('./submit');
    const result = submitSessionText('s2', 'git status');

    await Promise.resolve();
    expect(pasteToTerminal).toHaveBeenCalledWith('s2', 'git status');
    expect(sendInput).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await result;

    expect(sendInput).toHaveBeenCalledWith('s2', '\r');
    expect(submitQueuedLensTurn).not.toHaveBeenCalled();
  });
});
