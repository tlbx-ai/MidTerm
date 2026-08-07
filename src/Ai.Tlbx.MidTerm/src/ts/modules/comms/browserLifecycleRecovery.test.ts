import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectStateWebSocket: vi.fn(),
  reportBrowserActivity: vi.fn(),
  recoverVisibleTerminalsAfterBrowserResume: vi.fn(),
  suspendMuxForBrowserBackground: vi.fn(),
}));

vi.mock('../../stores', () => ({
  $activeSessionId: { get: () => 'sess1234' },
  $stateWsConnected: { get: () => true },
}));

vi.mock('./stateChannel', () => ({
  connectStateWebSocket: mocks.connectStateWebSocket,
  reportBrowserActivity: mocks.reportBrowserActivity,
}));

vi.mock('./muxChannel', () => ({
  recoverVisibleTerminalsAfterBrowserResume: mocks.recoverVisibleTerminalsAfterBrowserResume,
  suspendMuxForBrowserBackground: mocks.suspendMuxForBrowserBackground,
}));

import { setupBrowserLifecycleRecovery } from './browserLifecycleRecovery';

describe('browserLifecycleRecovery', () => {
  let fakeDocument: EventTarget & { visibilityState: DocumentVisibilityState };

  beforeEach(() => {
    vi.clearAllMocks();
    fakeDocument = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    });
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setVisibility(value: DocumentVisibilityState): void {
    Object.defineProperty(fakeDocument, 'visibilityState', {
      value,
      configurable: true,
    });
  }

  function setup(keepTerminalOutputActiveWhileHidden = false) {
    const options = {
      getVisibleTerminalSessionIds: vi.fn(() => ['sess1234']),
      syncMuxTerminalVisibility: vi.fn(),
      focusActiveTerminal: vi.fn(),
      applyScrollbackProtection: vi.fn(),
      keepTerminalOutputActiveWhileHidden: vi.fn(() => keepTerminalOutputActiveWhileHidden),
    };
    setupBrowserLifecycleRecovery(options);
    return options;
  }

  function emitDocument(type: string): void {
    fakeDocument.dispatchEvent(new Event(type));
  }

  it('suspends terminal transport while a desktop document is hidden', () => {
    const options = setup();
    setVisibility('hidden');

    emitDocument('visibilitychange');

    expect(mocks.reportBrowserActivity).toHaveBeenCalledTimes(1);
    expect(mocks.suspendMuxForBrowserBackground).toHaveBeenCalledTimes(1);
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).not.toHaveBeenCalled();
    expect(options.syncMuxTerminalVisibility).not.toHaveBeenCalled();
  });

  it('reconnects and restores visible terminal state on foreground', () => {
    const options = setup();
    setVisibility('visible');

    emitDocument('visibilitychange');

    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledWith('sess1234', [
      'sess1234',
    ]);
    expect(options.syncMuxTerminalVisibility).toHaveBeenCalledTimes(1);
    expect(options.focusActiveTerminal).toHaveBeenCalledTimes(1);
    expect(options.applyScrollbackProtection).toHaveBeenCalledTimes(1);
  });

  it('keeps hidden terminal output active for mobile PiP', () => {
    setup(true);
    setVisibility('hidden');

    emitDocument('visibilitychange');

    expect(mocks.suspendMuxForBrowserBackground).not.toHaveBeenCalled();
  });
});
