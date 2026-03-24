import {
  MUX_HEADER_SIZE,
  MUX_TYPE_BUFFER_REQUEST,
  MUX_TYPE_COMPRESSED_OUTPUT,
  MUX_TYPE_INPUT,
  MUX_TYPE_OUTPUT,
  MUX_TYPE_RESIZE,
  MUX_TYPE_RESYNC,
} from '../../constants';
import { createWsUrl, parseCompressedOutputFrame, parseOutputFrame } from '../../utils';
import { sessionTerminals } from '../../state';
import { getHubSessionRecord } from './runtime';
import { applyOutputFrameToTerminal } from '../comms/muxChannel';

let hubSocket: WebSocket | null = null;
let activeCompositeId: string | null = null;

function encodeSessionId(buffer: Uint8Array, offset: number, sessionId: string): void {
  for (let i = 0; i < 8; i++) {
    buffer[offset + i] = i < sessionId.length ? sessionId.charCodeAt(i) : 0;
  }
}

function closeHubSocket(): void {
  if (hubSocket) {
    try {
      hubSocket.close();
    } catch {
      // ignore
    }
  }
  hubSocket = null;
}

async function handleOutputFrame(data: Uint8Array): Promise<void> {
  if (!activeCompositeId) {
    return;
  }

  const state = sessionTerminals.get(activeCompositeId);
  if (!state) {
    return;
  }

  const type = data[0];
  if (type === 0xff) {
    return;
  }

  if (type !== MUX_TYPE_OUTPUT && type !== MUX_TYPE_COMPRESSED_OUTPUT && type !== MUX_TYPE_RESYNC) {
    return;
  }

  if (type === MUX_TYPE_RESYNC) {
    state.terminal.clear();
    return;
  }

  const payload = data.subarray(MUX_HEADER_SIZE);
  if (type === MUX_TYPE_COMPRESSED_OUTPUT) {
    const frame = await parseCompressedOutputFrame(payload);
    applyOutputFrameToTerminal(
      activeCompositeId,
      state,
      frame.sequenceEnd,
      frame.cols,
      frame.rows,
      frame.data,
    );
    return;
  }

  const frame = parseOutputFrame(payload);
  applyOutputFrameToTerminal(
    activeCompositeId,
    state,
    frame.sequenceEnd,
    frame.cols,
    frame.rows,
    frame.data,
  );
}

export function detachHubChannel(sessionId?: string): void {
  if (!sessionId || activeCompositeId === sessionId) {
    activeCompositeId = null;
    closeHubSocket();
  }
}

export function attachHubChannel(compositeId: string): void {
  const record = getHubSessionRecord(compositeId);
  if (!record) {
    return;
  }

  if (activeCompositeId === compositeId && hubSocket?.readyState === WebSocket.OPEN) {
    return;
  }

  activeCompositeId = compositeId;
  closeHubSocket();

  const params = new URLSearchParams({
    machineId: record.machineId,
    sessionId: record.remoteSessionId,
  });
  const ws = new WebSocket(createWsUrl(`/ws/hub/mux?${params.toString()}`));
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) {
      return;
    }

    void handleOutputFrame(new Uint8Array(event.data));
  };
  hubSocket = ws;
}

function sendFrame(frame: Uint8Array): void {
  if (!hubSocket || hubSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  hubSocket.send(frame);
}

export function sendHubInput(sessionId: string, data: string): void {
  const record = getHubSessionRecord(sessionId);
  if (!record) {
    return;
  }

  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(MUX_HEADER_SIZE + payload.length);
  frame[0] = MUX_TYPE_INPUT;
  encodeSessionId(frame, 1, record.remoteSessionId);
  frame.set(payload, MUX_HEADER_SIZE);
  sendFrame(frame);
}

export function sendHubResize(sessionId: string, cols: number, rows: number): void {
  const record = getHubSessionRecord(sessionId);
  if (!record) {
    return;
  }

  const frame = new Uint8Array(MUX_HEADER_SIZE + 4);
  frame[0] = MUX_TYPE_RESIZE;
  encodeSessionId(frame, 1, record.remoteSessionId);
  frame[MUX_HEADER_SIZE] = cols & 0xff;
  frame[MUX_HEADER_SIZE + 1] = (cols >> 8) & 0xff;
  frame[MUX_HEADER_SIZE + 2] = rows & 0xff;
  frame[MUX_HEADER_SIZE + 3] = (rows >> 8) & 0xff;
  sendFrame(frame);
}

export function requestHubBufferRefresh(sessionId: string): void {
  const record = getHubSessionRecord(sessionId);
  if (!record) {
    return;
  }

  const frame = new Uint8Array(MUX_HEADER_SIZE);
  frame[0] = MUX_TYPE_BUFFER_REQUEST;
  encodeSessionId(frame, 1, record.remoteSessionId);
  sendFrame(frame);
}
