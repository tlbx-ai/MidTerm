/**
 * Mux Channel Module
 *
 * Manages the mux WebSocket connection for terminal I/O.
 * Uses a binary protocol with 9-byte header (1 byte type + 8 byte session ID).
 */

import type { TerminalState } from '../../types';
import {
  MUX_HEADER_SIZE,
  MUX_TYPE_OUTPUT,
  MUX_TYPE_INPUT,
  MUX_TYPE_RESIZE,
  MUX_TYPE_RESYNC,
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY
} from '../../constants';
import { parseOutputFrame, scheduleReconnect } from '../../utils';
import {
  muxWs,
  muxReconnectTimer,
  muxReconnectDelay,
  sessionTerminals,
  pendingOutputFrames,
  setMuxWs,
  setMuxReconnectTimer,
  setMuxReconnectDelay,
  setMuxWsConnected
} from '../../state';
import { updateConnectionStatus } from './stateChannel';

// Forward declarations for functions from other modules
let applyTerminalScaling: (sessionId: string, state: TerminalState) => void = () => {};
let refreshActiveTerminalBuffer: () => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerMuxCallbacks(callbacks: {
  applyTerminalScaling?: (sessionId: string, state: TerminalState) => void;
  refreshActiveTerminalBuffer?: () => void;
}): void {
  if (callbacks.applyTerminalScaling) applyTerminalScaling = callbacks.applyTerminalScaling;
  if (callbacks.refreshActiveTerminalBuffer) refreshActiveTerminalBuffer = callbacks.refreshActiveTerminalBuffer;
}

/**
 * Connect to the mux WebSocket for terminal I/O.
 * Uses a binary protocol with 9-byte header.
 */
export function connectMuxWebSocket(): void {
  // Close existing WebSocket before creating new one
  if (muxWs) {
    muxWs.onclose = null; // Prevent reconnect loop
    muxWs.close();
    setMuxWs(null);
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/mux`);
  ws.binaryType = 'arraybuffer';
  setMuxWs(ws);

  ws.onopen = () => {
    const wasReconnect = muxReconnectDelay > INITIAL_RECONNECT_DELAY;
    setMuxReconnectDelay(INITIAL_RECONNECT_DELAY);
    setMuxWsConnected(true);
    updateConnectionStatus();

    // On reconnect, refresh buffers to catch any missed output
    if (wasReconnect) {
      refreshActiveTerminalBuffer();
    }
  };

  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;

    const data = new Uint8Array(event.data);
    if (data.length < MUX_HEADER_SIZE) return;

    const type = data[0];
    const sessionId = decodeSessionId(data, 1);
    const payload = data.slice(MUX_HEADER_SIZE);

    if (type === MUX_TYPE_RESYNC) {
      // Server is resyncing due to dropped frames - clear all terminals
      console.log('[Resync] Clearing terminals for buffer refresh');
      sessionTerminals.forEach((state) => {
        if (state.opened) {
          state.terminal.clear();
        }
      });
      pendingOutputFrames.clear();
      return;
    }

    if (type === MUX_TYPE_OUTPUT) {
      const state = sessionTerminals.get(sessionId);
      if (state && state.opened && payload.length >= 4) {
        writeOutputFrame(sessionId, state, payload);
      } else if (payload.length >= 4) {
        // Terminal not yet opened - buffer frame for replay when terminal opens
        if (!pendingOutputFrames.has(sessionId)) {
          pendingOutputFrames.set(sessionId, []);
        }
        pendingOutputFrames.get(sessionId)!.push(payload.slice());
      }
    }
  };

  ws.onclose = () => {
    setMuxWsConnected(false);
    updateConnectionStatus();
    scheduleMuxReconnect();
  };

  ws.onerror = (e) => {
    console.error('Mux WebSocket error:', e);
  };
}

/**
 * Send terminal input to server.
 */
export function sendInput(sessionId: string, data: string): void {
  if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;

  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(MUX_HEADER_SIZE + payload.length);
  frame[0] = MUX_TYPE_INPUT;
  encodeSessionId(frame, 1, sessionId);
  frame.set(payload, MUX_HEADER_SIZE);
  muxWs.send(frame);
}

/**
 * Send terminal resize to server.
 */
export function sendResize(sessionId: string, cols: number, rows: number): void {
  if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;

  const frame = new Uint8Array(MUX_HEADER_SIZE + 4);
  frame[0] = MUX_TYPE_RESIZE;
  encodeSessionId(frame, 1, sessionId);
  // Encode cols and rows as little-endian 16-bit integers
  frame[MUX_HEADER_SIZE] = cols & 0xff;
  frame[MUX_HEADER_SIZE + 1] = (cols >> 8) & 0xff;
  frame[MUX_HEADER_SIZE + 2] = rows & 0xff;
  frame[MUX_HEADER_SIZE + 3] = (rows >> 8) & 0xff;
  muxWs.send(frame);

  // Update local tracking
  const state = sessionTerminals.get(sessionId);
  if (state) {
    state.serverCols = cols;
    state.serverRows = rows;
  }
}

/**
 * Encode 8-character session ID into buffer at offset.
 */
export function encodeSessionId(buffer: Uint8Array, offset: number, sessionId: string): void {
  for (let i = 0; i < 8; i++) {
    buffer[offset + i] = i < sessionId.length ? sessionId.charCodeAt(i) : 0;
  }
}

/**
 * Decode 8-character session ID from buffer at offset.
 */
export function decodeSessionId(buffer: Uint8Array, offset: number): string {
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    const byte = buffer[offset + i];
    if (byte !== undefined && byte !== 0) {
      chars.push(String.fromCharCode(byte));
    }
  }
  return chars.join('');
}

/**
 * Schedule mux WebSocket reconnection with exponential backoff.
 */
export function scheduleMuxReconnect(): void {
  scheduleReconnect(
    muxReconnectDelay,
    MAX_RECONNECT_DELAY,
    connectMuxWebSocket,
    setMuxReconnectDelay,
    setMuxReconnectTimer,
    muxReconnectTimer
  );
}

/**
 * Replay pending output frames for a session that just opened its terminal.
 */
export function replayPendingFrames(sessionId: string, state: TerminalState): void {
  const frames = pendingOutputFrames.get(sessionId);
  if (frames && frames.length > 0) {
    frames.forEach((payload) => {
      writeOutputFrame(sessionId, state, payload);
    });
    pendingOutputFrames.delete(sessionId);
  }
}

/**
 * Write output frame to terminal.
 * Parses dimensions from frame header and resizes terminal if needed.
 */
export function writeOutputFrame(sessionId: string, state: TerminalState, payload: Uint8Array): void {
  const frame = parseOutputFrame(payload);

  // Ensure terminal matches frame dimensions before writing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termCore = (state.terminal as any)._core;
  if (frame.valid && termCore && termCore._renderService) {
    const currentCols = state.terminal.cols;
    const currentRows = state.terminal.rows;

    if (currentCols !== frame.cols || currentRows !== frame.rows) {
      try {
        state.terminal.resize(frame.cols, frame.rows);
        state.serverCols = frame.cols;
        state.serverRows = frame.rows;
        applyTerminalScaling(sessionId, state);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn('Terminal resize deferred:', message);
      }
    }
  }

  // Write terminal data
  if (frame.data.length > 0) {
    state.terminal.write(frame.data);
  }
}
