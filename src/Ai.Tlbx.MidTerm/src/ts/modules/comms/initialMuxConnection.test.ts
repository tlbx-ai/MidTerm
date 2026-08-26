import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectMuxWebSocket: vi.fn(),
  connectStateWebSocket: vi.fn(),
  hydrationCallback: null as (() => void) | null,
}));

vi.mock('./muxChannel', () => ({
  connectMuxWebSocket: mocks.connectMuxWebSocket,
}));

vi.mock('./stateChannel', () => ({
  connectStateWebSocket: mocks.connectStateWebSocket,
  setInitialStateHydratedCallback: vi.fn((callback: () => void) => {
    mocks.hydrationCallback = callback;
  }),
}));

import { connectInitialSessionTransports } from './initialMuxConnection';

describe('initial mux connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.hydrationCallback = null;
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens the mux once the state channel has selected the initial session', () => {
    connectInitialSessionTransports();

    expect(mocks.connectStateWebSocket).toHaveBeenCalledOnce();
    expect(mocks.connectMuxWebSocket).not.toHaveBeenCalled();

    mocks.hydrationCallback?.();
    vi.runAllTimers();

    expect(mocks.connectMuxWebSocket).toHaveBeenCalledOnce();
  });

  it('fails open when initial state hydration does not arrive', () => {
    connectInitialSessionTransports();

    vi.advanceTimersByTime(1499);
    expect(mocks.connectMuxWebSocket).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(mocks.connectMuxWebSocket).toHaveBeenCalledOnce();
  });
});
