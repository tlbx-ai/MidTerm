import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendLensTurn = vi.fn();
const interruptLensTurn = vi.fn();
const getActiveTab = vi.fn(() => 'agent');
const sessionState = {
  s1: {
    id: 's1',
    lensOnly: true,
  },
} as Record<string, { id: string; lensOnly: boolean }>;

vi.mock('../../api/client', () => ({
  interruptLensTurn,
  sendLensTurn,
}));

vi.mock('../../stores', () => ({
  $sessions: {
    get: () => sessionState,
  },
}));

vi.mock('../sessionTabs', () => ({
  getActiveTab,
}));

describe('lens input', () => {
  beforeEach(async () => {
    sendLensTurn.mockReset();
    interruptLensTurn.mockReset();
    getActiveTab.mockReset();
    getActiveTab.mockReturnValue('agent');
    sessionState.s1 = {
      id: 's1',
      lensOnly: true,
    };
    const { clearLensTurnSessionState } = await import('./input');
    clearLensTurnSessionState('s1');
  });

  it('requires a Lens-owned session before reporting Lens as active', async () => {
    const { isLensActiveSession } = await import('./input');

    expect(isLensActiveSession('s1')).toBe(true);

    sessionState.s1 = {
      id: 's1',
      lensOnly: false,
    };
    expect(isLensActiveSession('s1')).toBe(false);
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

  it('queues smart-input Lens turns while the current turn is running and drains them after completion', async () => {
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
      turnId: 'turn-queued',
      threadId: 'thread-1',
      quickSettings: {
        model: null,
        effort: null,
        planMode: 'off',
        permissionMode: 'manual',
      },
    });

    const { submitQueuedLensTurn, syncLensTurnExecutionState, LENS_TURN_ACCEPTED_EVENT } =
      await import('./input');

    syncLensTurnExecutionState('s1', { turnId: 'turn-1', state: 'running' });
    const queued = submitQueuedLensTurn('s1', {
      text: 'Run the next command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    expect(sendLensTurn).not.toHaveBeenCalled();

    syncLensTurnExecutionState('s1', { turnId: 'turn-1', state: 'completed' });
    await queued;

    expect(sendLensTurn).toHaveBeenCalledWith('s1', {
      text: 'Run the next command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    expect(dispatchEvent.mock.calls.map((call) => call[0]?.type)).toContain(
      LENS_TURN_ACCEPTED_EVENT,
    );
    vi.unstubAllGlobals();
  });

  it('halts queued Lens turns on a second escape press', async () => {
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

    interruptLensTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-1',
    });
    sendLensTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      provider: 'codex',
      turnId: 'turn-queued-1',
      threadId: 'thread-1',
      quickSettings: {
        model: null,
        effort: null,
        planMode: 'off',
        permissionMode: 'manual',
      },
    });

    const {
      submitQueuedLensTurn,
      syncLensTurnExecutionState,
      handleLensEscape,
      LENS_TURN_FAILED_EVENT,
    } = await import('./input');

    syncLensTurnExecutionState('s1', { turnId: 'turn-1', state: 'running' });
    const firstQueued = submitQueuedLensTurn('s1', {
      text: 'First queued command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    const secondQueued = submitQueuedLensTurn('s1', {
      text: 'Second queued command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    await handleLensEscape('s1');
    expect(interruptLensTurn).toHaveBeenCalledWith('s1', { turnId: 'turn-1' });

    syncLensTurnExecutionState('s1', { turnId: 'turn-1', state: 'interrupted' });
    await firstQueued;

    syncLensTurnExecutionState('s1', { turnId: 'turn-queued-1', state: 'running' });
    interruptLensTurn.mockResolvedValueOnce({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-queued-1',
    });

    await handleLensEscape('s1');

    await secondQueued;
    expect(interruptLensTurn).toHaveBeenLastCalledWith('s1', { turnId: 'turn-queued-1' });
    expect(dispatchEvent.mock.calls.map((call) => call[0]?.type)).toContain(LENS_TURN_FAILED_EVENT);
    vi.unstubAllGlobals();
  });

  it('remembers Escape during direct turn submission and interrupts once the turn is accepted', async () => {
    let resolveSubmission: ((value: unknown) => void) | null = null;
    sendLensTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    interruptLensTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-direct-1',
    });

    const { submitLensTurn, handleLensEscape } = await import('./input');

    const submission = submitLensTurn('s1', {
      text: 'Stop quickly.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    await Promise.resolve();
    await expect(handleLensEscape('s1')).resolves.toBe(true);

    resolveSubmission?.({
      sessionId: 's1',
      status: 'accepted',
      provider: 'codex',
      turnId: 'turn-direct-1',
      threadId: 'thread-1',
      quickSettings: {
        model: null,
        effort: null,
        planMode: 'off',
        permissionMode: 'manual',
      },
    });

    await submission;
    expect(interruptLensTurn).toHaveBeenCalledWith('s1', { turnId: 'turn-direct-1' });
  });

  it('reports interruptible Lens work synchronously for running and submitting turns', async () => {
    let resolveSubmission: ((value: unknown) => void) | null = null;
    sendLensTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );

    const { hasInterruptibleLensTurnWork, submitLensTurn, syncLensTurnExecutionState } =
      await import('./input');

    expect(hasInterruptibleLensTurnWork('s1')).toBe(false);

    syncLensTurnExecutionState('s1', { turnId: 'turn-running-1', state: 'running' });
    expect(hasInterruptibleLensTurnWork('s1')).toBe(true);

    syncLensTurnExecutionState('s1', { turnId: 'turn-running-1', state: 'completed' });
    expect(hasInterruptibleLensTurnWork('s1')).toBe(false);

    const submission = submitLensTurn('s1', {
      text: 'Interrupt me while submitting.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    await Promise.resolve();
    expect(hasInterruptibleLensTurnWork('s1')).toBe(true);

    resolveSubmission?.({
      sessionId: 's1',
      status: 'accepted',
      provider: 'codex',
      turnId: 'turn-submitting-1',
      threadId: 'thread-1',
      quickSettings: {
        model: null,
        effort: null,
        planMode: 'off',
        permissionMode: 'manual',
      },
    });

    await submission;
  });

  it('interrupts a queued turn even when Escape lands during the queued turn submission gap', async () => {
    interruptLensTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-1',
    });

    let resolveQueuedSubmission: ((value: unknown) => void) | null = null;
    sendLensTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQueuedSubmission = resolve;
        }),
    );

    const { submitQueuedLensTurn, syncLensTurnExecutionState, handleLensEscape } = await import(
      './input'
    );

    syncLensTurnExecutionState('s1', { turnId: 'turn-1', state: 'running' });
    const queued = submitQueuedLensTurn('s1', {
      text: 'Queued stop.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    await handleLensEscape('s1');
    syncLensTurnExecutionState('s1', { turnId: 'turn-1', state: 'interrupted' });
    await Promise.resolve();
    await handleLensEscape('s1');

    resolveQueuedSubmission?.({
      sessionId: 's1',
      status: 'accepted',
      provider: 'codex',
      turnId: 'turn-queued-2',
      threadId: 'thread-1',
      quickSettings: {
        model: null,
        effort: null,
        planMode: 'off',
        permissionMode: 'manual',
      },
    });

    await queued;
    expect(interruptLensTurn).toHaveBeenLastCalledWith('s1', { turnId: 'turn-queued-2' });
  });
});
