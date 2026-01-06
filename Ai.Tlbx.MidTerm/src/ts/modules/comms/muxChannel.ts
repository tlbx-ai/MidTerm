/**
 * Mux Channel Module
 *
 * Manages the mux WebSocket connection for terminal I/O.
 * Uses a binary protocol with 9-byte header (1 byte type + 8 byte session ID).
 *
 * CRITICAL: All output frames are processed strictly in order through a single queue.
 * This ensures TUI apps receive escape sequences in the correct order.
 */

import type { TerminalState } from '../../types';
import {
  MUX_HEADER_SIZE,
  MUX_TYPE_OUTPUT,
  MUX_TYPE_INPUT,
  MUX_TYPE_RESIZE,
  MUX_TYPE_RESYNC,
  MUX_TYPE_BUFFER_REQUEST,
  MUX_TYPE_COMPRESSED_OUTPUT,
  INITIAL_RECONNECT_DELAY,
  MAX_RECONNECT_DELAY
} from '../../constants';
import { parseOutputFrame, parseCompressedOutputFrame, scheduleReconnect } from '../../utils';
import {
  muxWs,
  muxReconnectTimer,
  muxReconnectDelay,
  muxHasConnected,
  sessionTerminals,
  pendingOutputFrames,
  setMuxWs,
  setMuxReconnectTimer,
  setMuxReconnectDelay,
  setMuxWsConnected,
  setMuxHasConnected
} from '../../state';
import { updateConnectionStatus } from './stateChannel';

// Forward declarations for functions from other modules
let applyTerminalScaling: (sessionId: string, state: TerminalState) => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerMuxCallbacks(callbacks: {
  applyTerminalScaling?: (sessionId: string, state: TerminalState) => void;
}): void {
  if (callbacks.applyTerminalScaling) applyTerminalScaling = callbacks.applyTerminalScaling;
}

// =============================================================================
// Strictly Ordered Output Queue
// =============================================================================

interface OutputFrameItem {
  sessionId: string;
  payload: Uint8Array;
  compressed: boolean;
}

const outputQueue: OutputFrameItem[] = [];
let processingQueue = false;

/**
 * Queue an output frame and trigger processing.
 * ALL frames go through this queue to guarantee strict ordering.
 */
function queueOutputFrame(sessionId: string, payload: Uint8Array, compressed: boolean): void {
  outputQueue.push({ sessionId, payload, compressed });
  processOutputQueue();
}

/**
 * Process output frames strictly in order.
 * Frames are processed one at a time - compressed frames block until decompressed.
 */
async function processOutputQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (outputQueue.length > 0) {
      const item = outputQueue.shift()!;
      await processOneFrame(item);
    }
  } finally {
    processingQueue = false;
  }
}

/**
 * Process a single frame - decompress if needed, then write to terminal.
 */
async function processOneFrame(item: OutputFrameItem): Promise<void> {
  try {
    let cols: number;
    let rows: number;
    let data: Uint8Array;

    if (item.compressed) {
      const frame = await parseCompressedOutputFrame(item.payload);
      cols = frame.cols;
      rows = frame.rows;
      data = frame.data;
    } else {
      const frame = parseOutputFrame(item.payload);
      cols = frame.cols;
      rows = frame.rows;
      data = frame.data;
    }

    const state = sessionTerminals.get(item.sessionId);
    if (state && state.opened) {
      writeToTerminal(item.sessionId, state, cols, rows, data);
    } else if (data.length > 0) {
      // Buffer for later replay
      const bufferedPayload = new Uint8Array(4 + data.length);
      bufferedPayload[0] = cols & 0xff;
      bufferedPayload[1] = (cols >> 8) & 0xff;
      bufferedPayload[2] = rows & 0xff;
      bufferedPayload[3] = (rows >> 8) & 0xff;
      bufferedPayload.set(data, 4);

      if (!pendingOutputFrames.has(item.sessionId)) {
        pendingOutputFrames.set(item.sessionId, []);
      }
      pendingOutputFrames.get(item.sessionId)!.push(bufferedPayload);
    }
  } catch (e) {
    console.error('Failed to process frame:', e);
  }
}

// Track bracketed paste mode per session
const bracketedPasteState = new Map<string, boolean>();

/** Check if session has bracketed paste mode enabled */
export function isBracketedPasteEnabled(sessionId: string): boolean {
  return bracketedPasteState.get(sessionId) ?? false;
}

/**
 * Write data to terminal, resizing if dimensions changed.
 */
function writeToTerminal(
  sessionId: string,
  state: TerminalState,
  cols: number,
  rows: number,
  data: Uint8Array
): void {
  // Track bracketed paste mode by detecting escape sequences
  if (data.length > 0) {
    const text = new TextDecoder().decode(data);
    if (text.includes('\x1b[?2004h')) {
      bracketedPasteState.set(sessionId, true);
    }
    if (text.includes('\x1b[?2004l')) {
      bracketedPasteState.set(sessionId, false);
    }
  }

  // Resize if dimensions are valid and different
  if (cols > 0 && rows > 0 && cols <= 500 && rows <= 500) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const termCore = (state.terminal as any)._core;
    if (termCore && termCore._renderService) {
      const currentCols = state.terminal.cols;
      const currentRows = state.terminal.rows;

      if (currentCols !== cols || currentRows !== rows) {
        try {
          state.terminal.resize(cols, rows);
          state.serverCols = cols;
          state.serverRows = rows;
          applyTerminalScaling(sessionId, state);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          console.warn('Terminal resize deferred:', message);
        }
      }
    }
  }

  // Always write data if present
  if (data.length > 0) {
    state.terminal.write(data);
  }
}

// =============================================================================
// WebSocket Connection
// =============================================================================

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
    // Detect reconnect: we've connected before AND have terminals to refresh
    const isReconnect = muxHasConnected && sessionTerminals.size > 0;

    setMuxReconnectDelay(INITIAL_RECONNECT_DELAY);
    setMuxWsConnected(true);
    setMuxHasConnected(true);
    updateConnectionStatus();

    // On reconnect, clear all terminals and request buffer refresh for each
    // This handles mt.exe restarts where sessions survive but connection is new
    if (isReconnect) {
      console.log(`[Mux] Reconnected - refreshing ${sessionTerminals.size} terminals`);
      pendingOutputFrames.clear();
      outputQueue.length = 0;
      sessionTerminals.forEach((state, sessionId) => {
        if (state.opened) {
          state.terminal.clear();
        }
        state.serverCols = 0;
        state.serverRows = 0;
        // Request buffer refresh for ALL terminals immediately
        requestBufferRefresh(sessionId);
      });
    } else {
      console.log('[Mux] Connected (first connection)');
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
      outputQueue.length = 0; // Clear pending queue too
      return;
    }

    if (type === MUX_TYPE_OUTPUT || type === MUX_TYPE_COMPRESSED_OUTPUT) {
      // Queue ALL output frames to guarantee strict ordering
      if (payload.length >= 4) {
        queueOutputFrame(sessionId, payload.slice(), type === MUX_TYPE_COMPRESSED_OUTPUT);
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
  frame[MUX_HEADER_SIZE] = cols & 0xff;
  frame[MUX_HEADER_SIZE + 1] = (cols >> 8) & 0xff;
  frame[MUX_HEADER_SIZE + 2] = rows & 0xff;
  frame[MUX_HEADER_SIZE + 3] = (rows >> 8) & 0xff;
  muxWs.send(frame);

  const state = sessionTerminals.get(sessionId);
  if (state) {
    state.serverCols = cols;
    state.serverRows = rows;
  }
}

/**
 * Request buffer refresh for a session via WebSocket.
 */
export function requestBufferRefresh(sessionId: string): void {
  if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;

  const frame = new Uint8Array(MUX_HEADER_SIZE);
  frame[0] = MUX_TYPE_BUFFER_REQUEST;
  encodeSessionId(frame, 1, sessionId);
  muxWs.send(frame);
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
 * Write output frame to terminal (used by manager.ts for replay).
 */
export function writeOutputFrame(sessionId: string, state: TerminalState, payload: Uint8Array): void {
  const frame = parseOutputFrame(payload);
  writeToTerminal(sessionId, state, frame.cols, frame.rows, frame.data);
}
