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

    const disconnect = openLensHistorySocket('session-1', 5, 0, 80, {
      onPatch: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0]!;
    const initialSubscribeCount = socket.sent.length;

    updateLensHistorySocketWindow('session-1', 0, 80);
    await Promise.resolve();

    expect(socket.sent).toHaveLength(initialSubscribeCount);

    updateLensHistorySocketWindow('session-1', 10, 80);
    await vi.waitFor(() => {
      expect(socket.sent).toHaveLength(initialSubscribeCount + 1);
    });

    disconnect();
  });
});
