import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendAppServerControlTurn = vi.fn();
const interruptAppServerControlTurn = vi.fn();
const getActiveTab = vi.fn(() => 'agent');
const sessionState = {
  s1: {
    id: 's1',
    appServerControlOnly: true,
  },
} as Record<string, { id: string; appServerControlOnly: boolean }>;

vi.mock('../../api/client', () => ({
  interruptAppServerControlTurn,
  sendAppServerControlTurn,
}));

vi.mock('../../stores', () => ({
  $sessions: {
    get: () => sessionState,
  },
}));

vi.mock('../sessionTabs', () => ({
  getActiveTab,
}));

describe('appServerControl input', () => {
  beforeEach(async () => {
    sendAppServerControlTurn.mockReset();
    interruptAppServerControlTurn.mockReset();
    getActiveTab.mockReset();
    getActiveTab.mockReturnValue('agent');
    sessionState.s1 = {
      id: 's1',
      appServerControlOnly: true,
    };
    const { clearAppServerControlTurnSessionState } = await import('./input');
    clearAppServerControlTurnSessionState('s1');
  });

  it('requires a AppServerControl-owned session before reporting AppServerControl as active', async () => {
    const { isAppServerControlActiveSession } = await import('./input');

    expect(isAppServerControlActiveSession('s1')).toBe(true);

    sessionState.s1 = {
      id: 's1',
      appServerControlOnly: false,
    };
    expect(isAppServerControlActiveSession('s1')).toBe(false);
  });

  it('dispatches optimistic lifecycle events around AppServerControl turn submission', async () => {
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
    sendAppServerControlTurn.mockResolvedValue({
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

    const {
      submitAppServerControlTurn,
      APP_SERVER_CONTROL_TURN_SUBMITTED_EVENT,
      APP_SERVER_CONTROL_TURN_ACCEPTED_EVENT,
    } = await import('./input');

    await submitAppServerControlTurn('s1', {
      text: 'Inspect the diff.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    expect(sendAppServerControlTurn).toHaveBeenCalledWith('s1', {
      text: 'Inspect the diff.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    expect(dispatchEvent.mock.calls.map((call) => call[0]?.type)).toEqual(
      expect.arrayContaining([
        APP_SERVER_CONTROL_TURN_SUBMITTED_EVENT,
        APP_SERVER_CONTROL_TURN_ACCEPTED_EVENT,
      ]),
    );
    vi.unstubAllGlobals();
  });

  it('queues smart-input AppServerControl turns while the current turn is running and drains them after completion', async () => {
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
    sendAppServerControlTurn.mockResolvedValue({
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

    const {
      submitQueuedAppServerControlTurn,
      syncAppServerControlTurnExecutionState,
      APP_SERVER_CONTROL_TURN_ACCEPTED_EVENT,
    } = await import('./input');

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-1', state: 'running' });
    const queued = submitQueuedAppServerControlTurn('s1', {
      text: 'Run the next command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    expect(sendAppServerControlTurn).not.toHaveBeenCalled();

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-1', state: 'completed' });
    await queued;

    expect(sendAppServerControlTurn).toHaveBeenCalledWith('s1', {
      text: 'Run the next command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    expect(dispatchEvent.mock.calls.map((call) => call[0]?.type)).toContain(
      APP_SERVER_CONTROL_TURN_ACCEPTED_EVENT,
    );
    vi.unstubAllGlobals();
  });

  it('halts queued AppServerControl turns on a second escape press', async () => {
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

    interruptAppServerControlTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-1',
    });
    sendAppServerControlTurn.mockResolvedValue({
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
      submitQueuedAppServerControlTurn,
      syncAppServerControlTurnExecutionState,
      handleAppServerControlEscape,
      APP_SERVER_CONTROL_TURN_FAILED_EVENT,
    } = await import('./input');

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-1', state: 'running' });
    const firstQueued = submitQueuedAppServerControlTurn('s1', {
      text: 'First queued command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    const secondQueued = submitQueuedAppServerControlTurn('s1', {
      text: 'Second queued command.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });
    await handleAppServerControlEscape('s1');
    expect(interruptAppServerControlTurn).toHaveBeenCalledWith('s1', { turnId: 'turn-1' });

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-1', state: 'interrupted' });
    await firstQueued;

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-queued-1', state: 'running' });
    interruptAppServerControlTurn.mockResolvedValueOnce({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-queued-1',
    });

    await handleAppServerControlEscape('s1');

    await secondQueued;
    expect(interruptAppServerControlTurn).toHaveBeenLastCalledWith('s1', {
      turnId: 'turn-queued-1',
    });
    expect(dispatchEvent.mock.calls.map((call) => call[0]?.type)).toContain(
      APP_SERVER_CONTROL_TURN_FAILED_EVENT,
    );
    vi.unstubAllGlobals();
  });

  it('remembers Escape during direct turn submission and interrupts once the turn is accepted', async () => {
    let resolveSubmission: ((value: unknown) => void) | null = null;
    sendAppServerControlTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    interruptAppServerControlTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-direct-1',
    });

    const { submitAppServerControlTurn, handleAppServerControlEscape } = await import('./input');

    const submission = submitAppServerControlTurn('s1', {
      text: 'Stop quickly.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    await Promise.resolve();
    await expect(handleAppServerControlEscape('s1')).resolves.toBe(true);

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
    expect(interruptAppServerControlTurn).toHaveBeenCalledWith('s1', { turnId: 'turn-direct-1' });
  });

  it('reports interruptible AppServerControl work synchronously for running and submitting turns', async () => {
    let resolveSubmission: ((value: unknown) => void) | null = null;
    sendAppServerControlTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );

    const {
      hasInterruptibleAppServerControlTurnWork,
      submitAppServerControlTurn,
      syncAppServerControlTurnExecutionState,
    } = await import('./input');

    expect(hasInterruptibleAppServerControlTurnWork('s1')).toBe(false);

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-running-1', state: 'running' });
    expect(hasInterruptibleAppServerControlTurnWork('s1')).toBe(true);

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-running-1', state: 'completed' });
    expect(hasInterruptibleAppServerControlTurnWork('s1')).toBe(false);

    const submission = submitAppServerControlTurn('s1', {
      text: 'Interrupt me while submitting.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    await Promise.resolve();
    expect(hasInterruptibleAppServerControlTurnWork('s1')).toBe(true);

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
    interruptAppServerControlTurn.mockResolvedValue({
      sessionId: 's1',
      status: 'accepted',
      turnId: 'turn-1',
    });

    let resolveQueuedSubmission: ((value: unknown) => void) | null = null;
    sendAppServerControlTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveQueuedSubmission = resolve;
        }),
    );

    const {
      submitQueuedAppServerControlTurn,
      syncAppServerControlTurnExecutionState,
      handleAppServerControlEscape,
    } = await import('./input');

    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-1', state: 'running' });
    const queued = submitQueuedAppServerControlTurn('s1', {
      text: 'Queued stop.',
      model: null,
      effort: null,
      planMode: 'off',
      permissionMode: 'manual',
      attachments: [],
    });

    await handleAppServerControlEscape('s1');
    syncAppServerControlTurnExecutionState('s1', { turnId: 'turn-1', state: 'interrupted' });
    await Promise.resolve();
    await handleAppServerControlEscape('s1');

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
    expect(interruptAppServerControlTurn).toHaveBeenLastCalledWith('s1', {
      turnId: 'turn-queued-2',
    });
  });
});
