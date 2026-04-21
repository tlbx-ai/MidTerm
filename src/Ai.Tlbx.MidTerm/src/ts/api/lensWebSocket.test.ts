import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils', () => ({
  createWsUrl: () => 'ws://localhost/ws/lens',
  ReconnectController: class {
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
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('lensWebSocket', () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not duplicate subscribe messages or resubscribe for an unchanged history window', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { openLensHistorySocket, updateLensHistorySocketWindow } = await import('./lensWebSocket');

    const disconnect = openLensHistorySocket('session-1', 5, 0, 80, 'rev-1', {
      onPatch: vi.fn(),
    }, 960);

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0]!;
    const initialSubscribeCount = socket.sent.length;

    updateLensHistorySocketWindow('session-1', 0, 80, 'rev-1', 960);
    await Promise.resolve();

    expect(socket.sent).toHaveLength(initialSubscribeCount);

    updateLensHistorySocketWindow('session-1', 10, 80, 'rev-2', 960);
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(initialSubscribeCount + 1);
    });

    disconnect();
  });

  it('ignores subscription history windows that do not match the current browser revision', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);

    const { openLensHistorySocket } = await import('./lensWebSocket');
    const onHistoryWindow = vi.fn();

    openLensHistorySocket('session-1', 0, 10, 40, 'rev-current', {
      onPatch: vi.fn(),
      onHistoryWindow,
    }, 960);

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
});
