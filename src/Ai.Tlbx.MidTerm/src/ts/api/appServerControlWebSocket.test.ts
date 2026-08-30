import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils', () => ({
  createWsUrl: () => 'ws://localhost/ws/app-server-control',
  ReconnectController: class {
    cancel(): void {}
    reset(): void {}
    schedule(): void {}
  },
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static autoOpen = true;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('appServerControlWebSocket', () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('does not duplicate subscribe messages or resubscribe for an unchanged history window', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { openAppServerControlHistorySocket, updateAppServerControlHistorySocketWindow } =
      await import('./appServerControlWebSocket');

    const disconnect = openAppServerControlHistorySocket(
      'session-1',
      5,
      0,
      80,
      'rev-1',
      {
        onPatch: vi.fn(),
      },
      960,
    );

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0]!;
    const initialSubscribeCount = socket.sent.length;

    updateAppServerControlHistorySocketWindow('session-1', 0, 80, 'rev-1', 960);
    await Promise.resolve();

    expect(socket.sent).toHaveLength(initialSubscribeCount);

    updateAppServerControlHistorySocketWindow('session-1', 10, 80, 'rev-2', 960);
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(initialSubscribeCount + 1);
    });

    disconnect();
  });

  it('ignores subscription history windows that do not match the current browser revision', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { openAppServerControlHistorySocket } = await import('./appServerControlWebSocket');
    const onHistoryWindow = vi.fn();

    openAppServerControlHistorySocket(
      'session-1',
      0,
      10,
      40,
      'rev-current',
      {
        onPatch: vi.fn(),
        onHistoryWindow,
      },
      960,
    );

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0]!;
    socket.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'history.window',
          sessionId: 'session-1',
          windowRevision: 'rev-stale',
          historyWindow: {
            sessionId: 'session-1',
            provider: 'codex',
            generatedAt: '2026-04-13T10:00:00Z',
            latestSequence: 7,
            historyCount: 20,
            historyWindowStart: 0,
            historyWindowEnd: 5,
            hasOlderHistory: false,
            hasNewerHistory: true,
            session: { state: 'ready', stateLabel: 'Ready' },
            thread: { threadId: 'thread-1', state: 'active', stateLabel: 'Active' },
            currentTurn: { state: 'running', stateLabel: 'Running' },
            quickSettings: { planMode: 'off', permissionMode: 'manual' },
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
          },
        }),
      }),
    );
    socket.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'history.window',
          sessionId: 'session-1',
          windowRevision: 'rev-current',
          historyWindow: {
            sessionId: 'session-1',
            provider: 'codex',
            generatedAt: '2026-04-13T10:00:01Z',
            latestSequence: 8,
            historyCount: 20,
            historyWindowStart: 5,
            historyWindowEnd: 10,
            hasOlderHistory: true,
            hasNewerHistory: true,
            session: { state: 'ready', stateLabel: 'Ready' },
            thread: { threadId: 'thread-1', state: 'active', stateLabel: 'Active' },
            currentTurn: { state: 'running', stateLabel: 'Running' },
            quickSettings: { planMode: 'off', permissionMode: 'manual' },
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
          },
        }),
      }),
    );

    expect(onHistoryWindow).toHaveBeenCalledTimes(1);
    expect(onHistoryWindow.mock.calls[0]?.[0]?.historyWindowStart).toBe(5);
    expect(onHistoryWindow.mock.calls[0]?.[0]?.windowRevision).toBe('rev-current');
  });

  it('rejects a connection attempt that closes before opening and permits a clean retry', async () => {
    FakeWebSocket.autoOpen = false;
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { attachAppServerControlSession } = await import('./appServerControlWebSocket');
    const firstAttempt = attachAppServerControlSession('session-1');
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.close();

    await expect(firstAttempt).rejects.toThrow('disconnected');

    const retry = attachAppServerControlSession('session-1');
    expect(FakeWebSocket.instances).toHaveLength(2);
    const retrySocket = FakeWebSocket.instances[1]!;
    retrySocket.open();
    await vi.waitFor(() => expect(retrySocket.sent).toHaveLength(1));
    const request = JSON.parse(retrySocket.sent[0] ?? '{}') as { id?: string };
    retrySocket.onmessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'ack',
          id: request.id,
          action: 'attach',
          sessionId: 'session-1',
        }),
      }),
    );

    await expect(retry).resolves.toBeUndefined();
  });

  it('bounds unanswered requests and clears their timeout after rejection', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { getAppServerControlHistoryWindowWs } = await import('./appServerControlWebSocket');
    const request = getAppServerControlHistoryWindowWs('session-1', 0, 40);
    const rejection = expect(request).rejects.toThrow('timed out');
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces a stale-open transport exactly once during foreground recovery', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { openAppServerControlHistorySocket, recoverAppServerControlWebSocket } =
      await import('./appServerControlWebSocket');
    const onOpen = vi.fn();
    const disconnect = openAppServerControlHistorySocket(
      'session-1',
      9,
      0,
      40,
      'rev-9',
      { onPatch: vi.fn(), onOpen },
      390,
    );
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));

    await recoverAppServerControlWebSocket();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1]?.sent).toHaveLength(1);
    disconnect();
  });
});
