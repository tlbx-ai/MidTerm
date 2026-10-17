import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  status: vi.fn(),
  recording: vi.fn(),
  process: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../stores', () => ({ $voiceAvailable: { set: mocks.available } }));
vi.mock('./sidebar/voiceSection', () => ({
  setVoiceStatus: mocks.status,
  setToggleRecording: mocks.recording,
}));
vi.mock('./voiceTools', () => ({ processToolRequest: mocks.process }));
vi.mock('./chat', () => ({
  addChatMessage: vi.fn(),
  showChatPanel: vi.fn(),
  toggleChatPanel: vi.fn(),
  showToolConfirmation: mocks.confirm,
  finalizeToolGroup: vi.fn(),
}));

class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(readonly url: string) {
    Socket.sockets.push(this);
  }
  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Socket.sockets = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'tailnet.test:2100' });
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: vi.fn().mockResolvedValue([]) } });
  vi.stubGlobal('window', {
    initAudioWithUserInteraction: vi.fn().mockResolvedValue(true),
    startRecording: vi.fn().mockResolvedValue(true),
    stopRecording: vi.fn().mockResolvedValue(undefined),
    stopAudioPlayback: vi.fn().mockResolvedValue(undefined),
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ providers: [{ id: 'openai', configured: true }] }),
      }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('local voice orchestration lifecycle', () => {
  it('uses the authenticated same-origin socket and captures only after readiness', async () => {
    const voice = await import('./voice');
    await voice.startVoiceSession();
    const socket = Socket.sockets[0]!;
    expect(socket.url).toBe('wss://tailnet.test:2100/ws/voice');
    socket.onopen?.();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'start', voice: 'marin' }));
    expect(window.startRecording).not.toHaveBeenCalled();
    socket.message({ type: 'ready' });
    await Promise.resolve();
    expect(window.startRecording).toHaveBeenCalledWith(expect.any(Function), 100, null, 24000);
    socket.onclose?.();
    await Promise.resolve();
    expect(window.stopRecording).toHaveBeenCalled();
    expect(window.stopAudioPlayback).toHaveBeenCalled();
    await voice.stopVoiceSession();
  });

  it('does not execute a confirmed tool after its conversation was stopped', async () => {
    let approve: (value: boolean) => void = () => {};
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
    );
    const voice = await import('./voice');
    await voice.startVoiceSession();
    Socket.sockets[0]!.message({
      type: 'tool_request',
      requestId: 'request',
      tool: 'make_input',
      args: { sessionId: 'terminal', text: 'echo test' },
      requiresConfirmation: true,
    });
    await Promise.resolve();
    expect(mocks.confirm).toHaveBeenCalled();
    await voice.stopVoiceSession();
    approve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it('cancels initialization without opening a socket or leaving recording active', async () => {
    let initialized: (value: boolean) => void = () => {};
    vi.mocked(window.initAudioWithUserInteraction!).mockReturnValue(
      new Promise<boolean>((resolve) => {
        initialized = resolve;
      }),
    );
    const voice = await import('./voice');
    const start = voice.startVoiceSession();
    await voice.stopVoiceSession();
    initialized(true);
    await start;
    expect(Socket.sockets).toHaveLength(0);
    expect(window.startRecording).not.toHaveBeenCalled();
  });
});
