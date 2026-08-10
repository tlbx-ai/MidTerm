import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentSettings: { language: 'en', theme: 'dark', fontSize: 14 },
  updateInfo: { version: '10.6.9-dev' },
  currentSettingsSet: vi.fn(),
  updateInfoSet: vi.fn(),
  settingsConnectedSet: vi.fn(),
  applyReceivedSettings: vi.fn(),
  handleUpdateInfo: vi.fn(),
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

vi.mock('../../utils', () => ({
  ReconnectController: class {
    cancel = vi.fn();
    reset = vi.fn();
    schedule = vi.fn();
  },
  createWsUrl: (path: string) => `wss://tlbx.test${path}`,
  closeWebSocket: (ws: FakeWebSocket | null, setter?: (value: null) => void) => {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close();
    setter?.(null);
  },
}));

vi.mock('../../stores', () => ({
  $currentSettings: {
    get: () => mocks.currentSettings,
    set: (value: unknown) => mocks.currentSettingsSet(value),
  },
  $updateInfo: {
    get: () => mocks.updateInfo,
    set: (value: unknown) => mocks.updateInfoSet(value),
  },
  $settingsWsConnected: {
    set: (value: unknown) => mocks.settingsConnectedSet(value),
    get: () => false,
  },
  areJsonLikeEqual: (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right),
}));

vi.mock('../auth/sessionLifetime', () => ({
  handleAuthenticatedWebSocketClose: () => false,
}));

vi.mock('../logging', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

vi.mock('../settings/persistence', () => ({
  applyReceivedSettings: (settings: unknown) => mocks.applyReceivedSettings(settings),
}));

vi.mock('../updating/checker', () => ({
  handleUpdateInfo: (update: unknown) => mocks.handleUpdateInfo(update),
}));

let connectSettingsWebSocket: typeof import('./settingsChannel').connectSettingsWebSocket;

describe('settingsChannel', () => {
  beforeAll(async () => {
    ({ connectSettingsWebSocket } = await import('./settingsChannel'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function connect(): FakeWebSocket {
    connectSettingsWebSocket();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error('Settings WebSocket was not created.');
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    return socket;
  }

  it('ignores the unchanged initial settings snapshot after a resume reconnect', () => {
    const socket = connect();

    socket.onmessage?.({
      data: JSON.stringify({ type: 'settings', settings: mocks.currentSettings }),
    } as MessageEvent<string>);

    expect(mocks.applyReceivedSettings).not.toHaveBeenCalled();
    expect(mocks.currentSettingsSet).not.toHaveBeenCalled();
  });

  it('applies a changed settings snapshot exactly once', () => {
    const socket = connect();
    const changed = { ...mocks.currentSettings, fontSize: 16 };

    socket.onmessage?.({
      data: JSON.stringify({ type: 'settings', settings: changed }),
    } as MessageEvent<string>);

    expect(mocks.applyReceivedSettings).toHaveBeenCalledOnce();
    expect(mocks.applyReceivedSettings).toHaveBeenCalledWith(changed);
    expect(mocks.currentSettingsSet).not.toHaveBeenCalled();
  });

  it('ignores an unchanged update snapshot', () => {
    const socket = connect();

    socket.onmessage?.({
      data: JSON.stringify({ type: 'update', update: mocks.updateInfo }),
    } as MessageEvent<string>);

    expect(mocks.handleUpdateInfo).not.toHaveBeenCalled();
    expect(mocks.updateInfoSet).not.toHaveBeenCalled();
  });
});
