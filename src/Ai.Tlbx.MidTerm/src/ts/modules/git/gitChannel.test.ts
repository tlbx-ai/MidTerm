import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils', () => ({
  createWsUrl: (path: string) => path,
  ReconnectController: class {
    cancel(): void {}
    reset(): void {}
    schedule(): void {}
  },
}));

vi.mock('../auth/sessionLifetime', () => ({
  handleAuthenticatedWebSocketClose: () => false,
}));

vi.mock('./gitApi', () => ({
  fetchGitRepos: vi.fn(),
  fetchGitStatus: vi.fn(),
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

import {
  disconnectGitWebSocket,
  recoverGitWebSocketAfterBrowserResume,
  subscribeToSession,
  suspendGitWebSocketForBrowserBackground,
  unsubscribeFromSession,
} from './gitChannel';

describe('Git browser lifecycle', () => {
  afterEach(() => {
    unsubscribeFromSession('session-a');
    disconnectGitWebSocket();
    FakeWebSocket.instances.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not reconnect while hidden and restores subscriptions on resume', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });

    subscribeToSession('session-a');
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0]!.open();

    suspendGitWebSocketForBrowserBackground();
    expect(FakeWebSocket.instances[0]!.readyState).toBe(FakeWebSocket.CLOSED);

    subscribeToSession('session-a');
    expect(FakeWebSocket.instances).toHaveLength(1);

    recoverGitWebSocketAfterBrowserResume();
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.open();
    expect(FakeWebSocket.instances[1]!.sent).toContain(
      JSON.stringify({ type: 'subscribe', sessionId: 'session-a' }),
    );
  });
});
