import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock('../process', () => ({
  handleForegroundChange: vi.fn(),
}));

vi.mock('../terminal/fileLinks', () => ({
  scanOutputForPaths: vi.fn(),
}));

vi.mock('../terminal/scaling', () => ({
  applyTerminalScaling: vi.fn(),
}));

vi.mock('../share', () => ({
  isSharedSessionRoute: () => false,
}));

vi.mock('./stateChannel', () => ({
  handleStateUpdate: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  getSessions: vi.fn(),
}));

vi.mock('../../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils')>();
  return {
    ...actual,
    checkVersionAndReload: vi.fn().mockResolvedValue(undefined),
    closeWebSocket: vi.fn(),
    createWsUrl: () => 'ws://midterm.test/ws/mux',
  };
});

class MockWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public static instances: MockWebSocket[] = [];

  public readonly url: string;
  public binaryType = 'blob';
  public readyState = MockWebSocket.OPEN;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
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

interface Harness {
  encodeSessionId: typeof import('./muxChannel')['encodeSessionId'];
  sessionTerminals: typeof import('../../state')['sessionTerminals'];
  stores: typeof import('../../stores');
  constants: typeof import('../../constants');
  ws: MockWebSocket;
}

interface FakeTerminalHarness {
  pendingCallbacks: Array<() => void>;
  writeMock: ReturnType<typeof vi.fn>;
}

function buildOutputMessage(
  encodeSessionId: (buffer: Uint8Array, offset: number, sessionId: string) => void,
  outputType: number,
  headerSize: number,
  sessionId: string,
  text: string,
  cols = 80,
  rows = 24,
): ArrayBuffer {
  const payload = new TextEncoder().encode(text);
  return buildSequencedOutputMessage(
    encodeSessionId,
    outputType,
    headerSize,
    sessionId,
    BigInt(payload.length),
    text,
    cols,
    rows,
  );
}

function buildSequencedOutputMessage(
  encodeSessionId: (buffer: Uint8Array, offset: number, sessionId: string) => void,
  outputType: number,
  headerSize: number,
  sessionId: string,
  sequenceEnd: bigint,
  text: string,
  cols = 80,
  rows = 24,
): ArrayBuffer {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(headerSize + 12 + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = outputType;
  encodeSessionId(frame, 1, sessionId);
  view.setBigUint64(headerSize, sequenceEnd, true);
  frame[headerSize + 8] = cols & 0xff;
  frame[headerSize + 9] = (cols >> 8) & 0xff;
  frame[headerSize + 10] = rows & 0xff;
  frame[headerSize + 11] = (rows >> 8) & 0xff;
  frame.set(payload, headerSize + 12);
  return frame.buffer;
}

function attachFakeTerminal(
  sessionTerminals: typeof import('../../state')['sessionTerminals'],
  sessionId: string,
): FakeTerminalHarness {
  const pendingCallbacks: Array<() => void> = [];
  const writeMock = vi.fn((_data: Uint8Array | string, callback?: () => void) => {
    if (callback) {
      pendingCallbacks.push(callback);
    }
  });

  const container = {
    classList: {
      contains: () => false,
    },
    getBoundingClientRect: () => ({ width: 640, height: 480 }),
    appendChild: vi.fn(),
    querySelector: vi.fn(() => null),
  } as unknown as HTMLDivElement;

  sessionTerminals.set(sessionId, {
    terminal: {
      cols: 80,
      rows: 24,
      modes: { synchronizedOutputMode: false },
      write: writeMock,
      resize: vi.fn(),
      clear: vi.fn(),
    },
    fitAddon: {} as never,
    container,
    serverCols: 80,
    serverRows: 24,
    opened: true,
  } as never);

  return { pendingCallbacks, writeMock };
}

async function loadHarness(nowValues: number[]): Promise<Harness> {
  vi.resetModules();
  MockWebSocket.instances = [];
  vi.spyOn(performance, 'now').mockImplementation(() => {
    const value = nowValues[0] ?? 0;
    if (nowValues.length > 1) {
      nowValues.shift();
    }
    return value;
  });
  vi.stubGlobal('WebSocket', MockWebSocket);

  const mux = await import('./muxChannel');
  const state = await import('../../state');
  const stores = await import('../../stores');
  const constants = await import('../../constants');

  state.sessionTerminals.clear();
  state.pendingOutputFrames.clear();
  state.sessionsNeedingResync.clear();
  stores.$activeSessionId.set('sess1234');
  stores.$currentSettings.set(null);
  stores.$dataLossDetected.set(null);
  stores.$muxHasConnected.set(false);
  stores.$muxWsConnected.set(false);
  stores.$stateWsConnected.set(false);

  mux.connectMuxWebSocket();

  const ws = MockWebSocket.instances[0];
  if (!ws) {
    throw new Error('Mock WebSocket was not created');
  }

  return {
    encodeSessionId: mux.encodeSessionId,
    sessionTerminals: state.sessionTerminals,
    stores,
    constants,
    ws,
  };
}

describe('muxChannel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('getComputedStyle', () => ({
      backgroundColor: 'rgb(0, 0, 0)',
    }));
    vi.stubGlobal('document', {
      createElement: () => ({
        className: '',
        style: {},
        setAttribute: vi.fn(),
        remove: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps draining queued output without waiting for prior xterm callbacks', async () => {
    const harness = await loadHarness([0, 0, 0, 0]);
    const sessionId = 'sess1234';
    const terminal = attachFakeTerminal(harness.sessionTerminals, sessionId);

    harness.ws.onmessage?.({
      data: buildOutputMessage(
        harness.encodeSessionId,
        harness.constants.MUX_TYPE_OUTPUT,
        harness.constants.MUX_HEADER_SIZE,
        sessionId,
        'first',
      ),
    } as MessageEvent<ArrayBuffer>);

    harness.ws.onmessage?.({
      data: buildOutputMessage(
        harness.encodeSessionId,
        harness.constants.MUX_TYPE_OUTPUT,
        harness.constants.MUX_HEADER_SIZE,
        sessionId,
        'second',
      ),
    } as MessageEvent<ArrayBuffer>);

    expect(terminal.writeMock).toHaveBeenCalledTimes(1);

    await Promise.resolve();

    expect(terminal.writeMock).toHaveBeenCalledTimes(2);
    expect(terminal.pendingCallbacks).toHaveLength(2);
    expect(harness.stores.$dataLossDetected.get()).toBeNull();
  });

  it('yields between drain slices so flood output does not monopolize the main thread', async () => {
    vi.useFakeTimers();

    const harness = await loadHarness([0, 9, 9, 9, 9]);
    const sessionId = 'sess1234';
    const terminal = attachFakeTerminal(harness.sessionTerminals, sessionId);

    harness.ws.onmessage?.({
      data: buildOutputMessage(
        harness.encodeSessionId,
        harness.constants.MUX_TYPE_OUTPUT,
        harness.constants.MUX_HEADER_SIZE,
        sessionId,
        'first',
      ),
    } as MessageEvent<ArrayBuffer>);

    harness.ws.onmessage?.({
      data: buildOutputMessage(
        harness.encodeSessionId,
        harness.constants.MUX_TYPE_OUTPUT,
        harness.constants.MUX_HEADER_SIZE,
        sessionId,
        'second',
      ),
    } as MessageEvent<ArrayBuffer>);

    await Promise.resolve();

    expect(terminal.writeMock).toHaveBeenCalledTimes(1);

    await vi.runOnlyPendingTimersAsync();

    expect(terminal.writeMock).toHaveBeenCalledTimes(2);
  });

  it('preserves open scrollback on reconnect and ignores duplicate tail replay frames', async () => {
    const harness = await loadHarness([0, 0, 0, 0, 0]);
    const sessionId = 'sess1234';
    const terminal = attachFakeTerminal(harness.sessionTerminals, sessionId);
    const state = harness.sessionTerminals.get(sessionId);
    if (!state) {
      throw new Error('missing terminal state');
    }

    harness.ws.onmessage?.({
      data: buildSequencedOutputMessage(
        harness.encodeSessionId,
        harness.constants.MUX_TYPE_OUTPUT,
        harness.constants.MUX_HEADER_SIZE,
        sessionId,
        5n,
        'first',
      ),
    } as MessageEvent<ArrayBuffer>);

    await Promise.resolve();

    expect(terminal.writeMock).toHaveBeenCalledTimes(1);

    harness.stores.$muxHasConnected.set(true);
    harness.ws.onopen?.(new Event('open'));

    expect(state.terminal.clear).not.toHaveBeenCalled();

    harness.ws.onmessage?.({
      data: buildSequencedOutputMessage(
        harness.encodeSessionId,
        harness.constants.MUX_TYPE_OUTPUT,
        harness.constants.MUX_HEADER_SIZE,
        sessionId,
        5n,
        'first',
      ),
    } as MessageEvent<ArrayBuffer>);

    await Promise.resolve();

    expect(terminal.writeMock).toHaveBeenCalledTimes(1);
  });
});
