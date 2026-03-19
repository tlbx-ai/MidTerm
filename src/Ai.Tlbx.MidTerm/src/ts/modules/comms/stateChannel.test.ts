import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeWebSocket: vi.fn(),
  createTerminalForSession: vi.fn(),
  destroyTerminalForSession: vi.fn(),
  applyTerminalScaling: vi.fn(),
  handleSessionClosed: vi.fn(),
  updateEmptyState: vi.fn(),
  updateMobileTitle: vi.fn(),
  renderUpdatePanel: vi.fn(),
  handleHiddenSessionClosed: vi.fn(),
  closeOverlay: vi.fn(),
  detachPreview: vi.fn(),
  dockBack: vi.fn(),
  isDetachedOpenForSession: vi.fn(() => false),
  setDetachedPreviewViewport: vi.fn(() => false),
  setViewportSize: vi.fn(),
  openWebPreviewDock: vi.fn(),
  setWebPreviewTarget: vi.fn(),
  getSessionPreview: vi.fn(() => null),
  getSessionSelectedPreviewName: vi.fn(() => 'default'),
  setSessionMode: vi.fn(),
  setSessionSelectedPreviewName: vi.fn((_sessionId: string, previewName?: string | null) =>
    previewName?.trim() ? previewName.trim() : 'default',
  ),
  upsertSessionPreview: vi.fn(),
  syncActiveWebPreview: vi.fn().mockResolvedValue(undefined),
  isSessionInLayout: vi.fn(() => false),
  restoreLayoutFromStorage: vi.fn(),
  dockSession: vi.fn(),
  swapLayoutSessions: vi.fn(),
  initializeFromSession: vi.fn(),
  selectSession: vi.fn(),
}));

vi.mock('../../utils', () => ({
  ReconnectController: class {
    reset(): void {}
    schedule(): void {}
  },
  createWsUrl: () => 'ws://midterm.test/ws/state',
  closeWebSocket: mocks.closeWebSocket,
}));

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock('../process', () => ({
  initializeFromSession: mocks.initializeFromSession,
}));

vi.mock('../terminal/manager', () => ({
  destroyTerminalForSession: mocks.destroyTerminalForSession,
  createTerminalForSession: mocks.createTerminalForSession,
}));

vi.mock('../terminal/scaling', () => ({
  applyTerminalScaling: mocks.applyTerminalScaling,
}));

vi.mock('../layout', () => ({
  handleSessionClosed: mocks.handleSessionClosed,
}));

vi.mock('../sidebar/sessionList', () => ({
  updateEmptyState: mocks.updateEmptyState,
  updateMobileTitle: mocks.updateMobileTitle,
}));

vi.mock('../updating/checker', () => ({
  renderUpdatePanel: mocks.renderUpdatePanel,
}));

vi.mock('../commands/commandsPanel', () => ({
  handleHiddenSessionClosed: mocks.handleHiddenSessionClosed,
}));

vi.mock('../commands/outputPanel', () => ({
  closeOverlay: mocks.closeOverlay,
}));

vi.mock('../web/webDetach', () => ({
  detachPreview: mocks.detachPreview,
  dockBack: mocks.dockBack,
  isDetachedOpenForSession: mocks.isDetachedOpenForSession,
  setDetachedPreviewViewport: mocks.setDetachedPreviewViewport,
}));

vi.mock('../web/webDock', () => ({
  setViewportSize: mocks.setViewportSize,
  openWebPreviewDock: mocks.openWebPreviewDock,
}));

vi.mock('../web/webApi', () => ({
  setWebPreviewTarget: mocks.setWebPreviewTarget,
}));

vi.mock('../web/webSessionState', () => ({
  getSessionPreview: mocks.getSessionPreview,
  getSessionSelectedPreviewName: mocks.getSessionSelectedPreviewName,
  setSessionMode: mocks.setSessionMode,
  setSessionSelectedPreviewName: mocks.setSessionSelectedPreviewName,
  upsertSessionPreview: mocks.upsertSessionPreview,
}));

vi.mock('../web', () => ({
  syncActiveWebPreview: mocks.syncActiveWebPreview,
}));

vi.mock('../web/webContext', () => ({
  isEmbeddedWebPreviewContext: () => false,
}));

vi.mock('../share', () => ({
  isSharedSessionRoute: () => false,
}));

vi.mock('../layout/layoutStore', () => ({
  restoreLayoutFromStorage: mocks.restoreLayoutFromStorage,
  dockSession: mocks.dockSession,
  isSessionInLayout: mocks.isSessionInLayout,
  swapLayoutSessions: mocks.swapLayoutSessions,
}));

class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public static instances: MockWebSocket[] = [];

  public readonly url: string;
  public readyState = MockWebSocket.OPEN;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public send = vi.fn();
  public close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  public constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

async function loadHarness() {
  vi.resetModules();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);

  Object.values(mocks).forEach((value) => {
    if ('mockReset' in value && typeof value.mockReset === 'function') {
      value.mockReset();
    }
  });

  mocks.isDetachedOpenForSession.mockReturnValue(false);
  mocks.setDetachedPreviewViewport.mockReturnValue(false);
  mocks.getSessionPreview.mockReturnValue(null);
  mocks.getSessionSelectedPreviewName.mockReturnValue('default');
  mocks.setSessionSelectedPreviewName.mockImplementation(
    (_sessionId: string, previewName?: string | null) =>
      previewName?.trim() ? previewName.trim() : 'default',
  );
  mocks.syncActiveWebPreview.mockResolvedValue(undefined);

  const stores = await import('../../stores');
  stores.$activeSessionId.set('user1234');
  stores.$settingsOpen.set(false);
  stores.$webPreviewUrl.set(null);
  stores.$stateWsConnected.set(false);
  stores.$sessions.set({});

  const state = await import('../../state');
  state.setStateWs(null);
  state.sessionTerminals.clear();
  state.hiddenSessionIds.clear();
  state.newlyCreatedSessions.clear();

  const stateChannel = await import('./stateChannel');
  stateChannel.setSelectSessionCallback(mocks.selectSession);
  stateChannel.connectStateWebSocket();

  const ws = MockWebSocket.instances[0];
  if (!ws) {
    throw new Error('Mock WebSocket was not created');
  }

  return { stores, ws };
}

describe('stateChannel browser-ui handling', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not switch sessions when opening a preview for a background session', async () => {
    const { stores, ws } = await loadHarness();
    mocks.setWebPreviewTarget.mockResolvedValue({
      sessionId: 'agent5678',
      previewName: 'default',
      routeKey: 'route-1',
      url: 'http://localhost:3000',
      active: true,
    });

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'browser-ui',
        command: 'open',
        sessionId: 'agent5678',
        previewName: 'default',
        url: 'http://localhost:3000',
      }),
    } as MessageEvent<string>);

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.selectSession).not.toHaveBeenCalled();
    expect(stores.$activeSessionId.get()).toBe('user1234');
    expect(mocks.openWebPreviewDock).not.toHaveBeenCalled();
    expect(mocks.syncActiveWebPreview).not.toHaveBeenCalled();
    expect(mocks.setWebPreviewTarget).toHaveBeenCalledWith(
      'agent5678',
      'default',
      'http://localhost:3000',
    );
    expect(mocks.upsertSessionPreview).toHaveBeenCalledWith({
      sessionId: 'agent5678',
      previewName: 'default',
      routeKey: 'route-1',
      url: 'http://localhost:3000',
      active: true,
    });
  });
});
