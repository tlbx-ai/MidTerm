import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectStateWebSocket: vi.fn(),
  reportBrowserActivity: vi.fn(),
  recoverVisibleTerminalsAfterBrowserResume: vi.fn(),
  suspendMuxForBrowserBackground: vi.fn(),
  stateWsConnected: true,
}));

vi.mock('../../stores', () => ({
  $activeSessionId: { get: () => 'sess1234' },
  $stateWsConnected: { get: () => mocks.stateWsConnected },
}));

vi.mock('./stateChannel', () => ({
  connectStateWebSocket: mocks.connectStateWebSocket,
  reportBrowserActivity: mocks.reportBrowserActivity,
}));

vi.mock('./muxChannel', () => ({
  recoverVisibleTerminalsAfterBrowserResume: mocks.recoverVisibleTerminalsAfterBrowserResume,
  suspendMuxForBrowserBackground: mocks.suspendMuxForBrowserBackground,
}));

import {
  hasSuspendedForegroundEventLoop,
  setupBrowserLifecycleRecovery,
} from './browserLifecycleRecovery';

describe('browserLifecycleRecovery', () => {
  let fakeDocument: EventTarget & { visibilityState: DocumentVisibilityState };
  let fakeWindow: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    vi.clearAllMocks();
    mocks.stateWsConnected = true;
    fakeDocument = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    });
    fakeWindow = new EventTarget();
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', fakeWindow);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      reconnectSettingsAfterLongResume: vi.fn(),
      recoverAppServerControlAfterResume: vi.fn(),
    };
    const dispose = setupBrowserLifecycleRecovery(options);
    return { ...options, dispose };
  }

  function emitDocument(type: string): void {
    fakeDocument.dispatchEvent(new Event(type));
  }

  function emitWindow(type: string): void {
    fakeWindow.dispatchEvent(new Event(type));
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

  it('restores visible terminal state without replacing healthy transports on ordinary focus', () => {
    const options = setup();
    setVisibility('visible');

    emitDocument('visibilitychange');
    vi.advanceTimersByTime(0);

    expect(mocks.connectStateWebSocket).not.toHaveBeenCalled();
    expect(options.reconnectSettingsAfterLongResume).not.toHaveBeenCalled();
    expect(options.recoverAppServerControlAfterResume).not.toHaveBeenCalled();
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledWith(
      'sess1234',
      ['sess1234'],
      { forceReconnect: false },
    );
    expect(options.syncMuxTerminalVisibility).toHaveBeenCalledTimes(1);
    expect(options.focusActiveTerminal).toHaveBeenCalledTimes(1);
    expect(options.applyScrollbackProtection).toHaveBeenCalledTimes(1);
  });

  it('replaces stale-open core transports once after a long background interval', () => {
    const options = setup();
    setVisibility('hidden');
    emitDocument('visibilitychange');
    vi.advanceTimersByTime(6000);

    setVisibility('visible');
    emitDocument('visibilitychange');
    emitWindow('focus');
    emitWindow('pageshow');
    emitDocument('resume');
    vi.advanceTimersByTime(0);

    expect(mocks.connectStateWebSocket).toHaveBeenCalledTimes(1);
    expect(options.reconnectSettingsAfterLongResume).toHaveBeenCalledTimes(1);
    expect(options.recoverAppServerControlAfterResume).toHaveBeenCalledTimes(1);
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledTimes(1);
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledWith(
      'sess1234',
      ['sess1234'],
      { forceReconnect: true },
    );
    expect(options.syncMuxTerminalVisibility).toHaveBeenCalledTimes(1);
    expect(options.focusActiveTerminal).toHaveBeenCalledTimes(1);
    expect(options.applyScrollbackProtection).toHaveBeenCalledTimes(1);
  });

  it('replaces browser-owned transports immediately after a short real background interval', () => {
    const options = setup();
    setVisibility('hidden');
    emitDocument('visibilitychange');
    vi.advanceTimersByTime(250);

    setVisibility('visible');
    emitDocument('visibilitychange');
    emitWindow('focus');
    vi.advanceTimersByTime(0);

    expect(mocks.connectStateWebSocket).toHaveBeenCalledTimes(1);
    expect(options.reconnectSettingsAfterLongResume).toHaveBeenCalledTimes(1);
    expect(options.recoverAppServerControlAfterResume).toHaveBeenCalledTimes(1);
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledWith(
      'sess1234',
      ['sess1234'],
      { forceReconnect: true },
    );
  });

  it('coalesces duplicate foreground events without hiding the document first', () => {
    const options = setup();

    emitWindow('focus');
    emitWindow('pageshow');
    emitDocument('resume');
    vi.advanceTimersByTime(0);

    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledTimes(1);
    expect(options.focusActiveTerminal).toHaveBeenCalledTimes(1);
  });

  it('does not classify a visible window blur as a browser suspension', () => {
    const options = setup();

    emitWindow('blur');
    vi.advanceTimersByTime(6000);
    emitWindow('focus');
    vi.advanceTimersByTime(0);

    expect(mocks.connectStateWebSocket).not.toHaveBeenCalled();
    expect(options.reconnectSettingsAfterLongResume).not.toHaveBeenCalled();
    expect(options.recoverAppServerControlAfterResume).not.toHaveBeenCalled();
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).toHaveBeenCalledWith(
      'sess1234',
      ['sess1234'],
      { forceReconnect: false },
    );
  });

  it('removes lifecycle listeners and timers when disposed', () => {
    const options = setup();
    options.dispose();

    setVisibility('hidden');
    emitDocument('visibilitychange');
    emitWindow('focus');
    vi.advanceTimersByTime(10000);

    expect(mocks.suspendMuxForBrowserBackground).not.toHaveBeenCalled();
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps hidden terminal output active for mobile PiP', () => {
    setup(true);
    setVisibility('hidden');

    emitDocument('visibilitychange');

    expect(mocks.suspendMuxForBrowserBackground).not.toHaveBeenCalled();
  });

  it('reconnects state immediately when its store already reports a disconnect', () => {
    mocks.stateWsConnected = false;
    setup();

    emitWindow('focus');
    vi.advanceTimersByTime(0);

    expect(mocks.connectStateWebSocket).toHaveBeenCalledTimes(1);
  });

  it('replaces transports when the event loop resumes without lifecycle events', () => {
    expect(hasSuspendedForegroundEventLoop(1000, 7000)).toBe(true);
    expect(hasSuspendedForegroundEventLoop(1000, 5999)).toBe(false);
  });

  it('does not recover transports for an on-time foreground heartbeat', () => {
    setup();

    vi.advanceTimersByTime(1000);

    expect(mocks.connectStateWebSocket).not.toHaveBeenCalled();
    expect(mocks.recoverVisibleTerminalsAfterBrowserResume).not.toHaveBeenCalled();
  });
});
