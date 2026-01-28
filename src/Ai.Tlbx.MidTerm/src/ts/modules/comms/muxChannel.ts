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
import { createLogger } from '../logging';
import {
  MUX_HEADER_SIZE,
  MUX_PROTOCOL_VERSION,
  MUX_MIN_COMPATIBLE_VERSION,
  MUX_TYPE_OUTPUT,
  MUX_TYPE_INPUT,
  MUX_TYPE_RESIZE,
  MUX_TYPE_RESYNC,
  MUX_TYPE_BUFFER_REQUEST,
  MUX_TYPE_COMPRESSED_OUTPUT,
  MUX_TYPE_ACTIVE_HINT,
  MUX_TYPE_FOREGROUND_CHANGE,
  MUX_TYPE_DATA_LOSS,
  WS_CLOSE_SERVER_SHUTDOWN,
} from '../../constants';
import type { ForegroundChangePayload } from '../../types';
import { handleForegroundChange } from '../process';
import { scanOutputForPaths } from '../terminal/fileLinks';
import {
  parseOutputFrame,
  parseCompressedOutputFrame,
  scheduleReconnect,
  checkVersionAndReload,
  createWsUrl,
  closeWebSocket,
} from '../../utils';
import {
  muxWs,
  muxReconnectTimer,
  sessionTerminals,
  pendingOutputFrames,
  sessionsNeedingResync,
  setMuxWs,
  setMuxReconnectTimer,
  setServerProtocolVersion,
  setBellNotificationsSuppressed,
  addWsRxBytes,
  addWsTxBytes,
} from '../../state';
import {
  $muxWsConnected,
  $muxHasConnected,
  $activeSessionId,
  $stateWsConnected,
  $dataLossDetected,
} from '../../stores';

const log = createLogger('mux');

// Cached TextDecoder to avoid allocation per frame
const textDecoder = new TextDecoder();

// =============================================================================
// Input Buffering (Issue #2: Lost keystrokes during reconnection)
// =============================================================================

interface PendingInput {
  sessionId: string;
  data: string;
}

const pendingInputQueue: PendingInput[] = [];
const MAX_PENDING_INPUT = 100;

/**
 * Fetch fresh session list from server via REST API.
 * Used to ensure state consistency after mux reconnect.
 */
async function refreshSessionList(): Promise<void> {
  try {
    const response = await fetch('/api/sessions');
    if (!response.ok) return;

    const data = await response.json();
    const sessions = data?.sessions ?? [];

    // Import dynamically to avoid circular dependency
    const { handleStateUpdate } = await import('./stateChannel');
    handleStateUpdate(sessions);
    log.info(() => `Refreshed session list: ${sessions.length} sessions`);
  } catch (e) {
    log.warn(() => `Failed to refresh session list: ${e}`);
  }
}

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

const MAX_QUEUE_SIZE = 10000;
const MAX_PENDING_FRAMES_PER_SESSION = 1000;
// Compact array when this many items have been processed (amortizes O(n) splice cost)
const COMPACT_THRESHOLD = 1000;

const outputQueue: OutputFrameItem[] = [];
let processingQueue = false;
let queueIndex = 0;

/**
 * Compact the queue by removing processed items.
 * Called periodically to bound memory usage during high throughput.
 */
function compactQueue(): void {
  if (queueIndex > 0) {
    outputQueue.splice(0, queueIndex);
    queueIndex = 0;
  }
}

/**
 * Queue an output frame and trigger processing.
 * ALL frames go through this queue to guarantee strict ordering.
 * Drops oldest unprocessed frames when queue is full to prevent OOM.
 */
function queueOutputFrame(sessionId: string, payload: Uint8Array, compressed: boolean): void {
  const pendingCount = outputQueue.length - queueIndex;
  if (pendingCount >= MAX_QUEUE_SIZE) {
    const droppedItem = outputQueue[queueIndex];
    log.warn(
      () => `Output queue full, dropping oldest frame for session ${droppedItem?.sessionId}`,
    );
    // Notify UI of data loss
    if (droppedItem) {
      $dataLossDetected.set({ sessionId: droppedItem.sessionId, timestamp: Date.now() });
    }
    queueIndex++; // Skip oldest unprocessed frame
    // Compact to actually free memory
    if (queueIndex >= COMPACT_THRESHOLD) {
      compactQueue();
    }
  }
  outputQueue.push({ sessionId, payload, compressed });
  processOutputQueue();
}

/**
 * Process output frames strictly in order.
 * Frames are processed one at a time - compressed frames block until decompressed.
 * Uses cursor-based indexing with periodic compaction for O(1) amortized dequeue.
 */
async function processOutputQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (queueIndex < outputQueue.length) {
      const item = outputQueue[queueIndex++]!;
      await processOneFrame(item);

      // Compact periodically to bound memory during sustained high throughput
      if (queueIndex >= COMPACT_THRESHOLD) {
        compactQueue();
      }
    }
    // Clear any remaining processed items
    outputQueue.length = 0;
    queueIndex = 0;
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
      const frames = pendingOutputFrames.get(item.sessionId)!;
      if (frames.length >= MAX_PENDING_FRAMES_PER_SESSION) {
        // Overflow: partial data is useless for TUI apps, request immediate resync
        log.warn(() => `Pending frames overflow for ${item.sessionId}, requesting buffer refresh`);
        sessionsNeedingResync.add(item.sessionId);
        pendingOutputFrames.delete(item.sessionId);
        requestBufferRefresh(item.sessionId);
        return;
      }
      frames.push(bufferedPayload);
    }
  } catch (e) {
    log.error(() => `Failed to process frame: ${e}`);
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
  data: Uint8Array,
): void {
  // Track bracketed paste mode by detecting escape sequences
  if (data.length > 0) {
    const text = textDecoder.decode(data);
    if (text.includes('\x1b[?2004h')) {
      bracketedPasteState.set(sessionId, true);
    }
    if (text.includes('\x1b[?2004l')) {
      bracketedPasteState.set(sessionId, false);
    }
  }

  // Resize if dimensions are valid and different
  if (cols > 0 && rows > 0 && cols <= 500 && rows <= 500 && state.opened) {
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
        log.warn(() => `Terminal resize deferred: ${message}`);
      }
    }
  }

  // Always write data if present
  if (data.length > 0) {
    state.terminal.write(data);
    // Scan for file paths (File Radar feature)
    scanOutputForPaths(sessionId, data);
  }

  // DISABLED: Was causing cursor to disappear in some cases
  // if (didResize) {
  //   state.terminal.write('\x1b[?25h');
  // }
}

// =============================================================================
// WebSocket Connection
// =============================================================================

/**
 * Connect to the mux WebSocket for terminal I/O.
 * Uses a binary protocol with 9-byte header.
 */
export function connectMuxWebSocket(): void {
  closeWebSocket(muxWs, setMuxWs);

  const ws = new WebSocket(createWsUrl('/ws/mux'));
  ws.binaryType = 'arraybuffer';
  setMuxWs(ws);

  ws.onopen = () => {
    // Suppress bell notifications during initial buffer replay
    setBellNotificationsSuppressed(true);
    setTimeout(() => setBellNotificationsSuppressed(false), 1000);

    // Detect reconnect: we've connected before AND have terminals to refresh
    const isReconnect = $muxHasConnected.get() && sessionTerminals.size > 0;

    $muxWsConnected.set(true);
    $muxHasConnected.set(true);

    // On reconnect, check if server version changed (update applied) and reload
    if (isReconnect) {
      checkVersionAndReload();
      log.info(() => `Reconnected - refreshing ${sessionTerminals.size} terminals`);
      pendingOutputFrames.clear();
      sessionsNeedingResync.clear();
      outputQueue.length = 0;
      sessionTerminals.forEach((state) => {
        if (state.opened) {
          state.terminal.clear();
          state.terminal.write('\x1b[0m');
        }
        state.serverCols = 0;
        state.serverRows = 0;
        // Server pushes all buffers on connect via SendInitialBuffersAsync
      });

      // If state WS is connected, fetch fresh session list to ensure consistency
      // (state WS may have missed updates while mux was disconnected)
      if ($stateWsConnected.get()) {
        refreshSessionList();
      }
    } else {
      log.info(() => 'Connected (first connection)');
    }

    // Send active session hint so server knows which session to prioritize
    const activeId = $activeSessionId.get();
    if (activeId) {
      sendActiveSessionHint(activeId);
    }

    // Flush any input buffered during disconnection
    flushPendingInput();

    // DISABLED: Was causing cursor to disappear in some cases
    // sessionTerminals.forEach((state) => {
    //   if (state.opened) {
    //     state.terminal.write('\x1b[?25h');
    //   }
    // });
  };

  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    addWsRxBytes(event.data.byteLength);

    const data = new Uint8Array(event.data);
    if (data.length < MUX_HEADER_SIZE) return;

    const type = data[0];

    // Handle init frame (0xFF) - contains protocol version
    if (type === 0xff) {
      // Init frame format: [0xFF][clientId:8][protocolVersion:2][fullClientId:32]
      if (data.length >= MUX_HEADER_SIZE + 2) {
        const serverVersion = data[MUX_HEADER_SIZE]! | (data[MUX_HEADER_SIZE + 1]! << 8);
        setServerProtocolVersion(serverVersion);
        log.info(
          () =>
            `Server protocol version: ${serverVersion}, client version: ${MUX_PROTOCOL_VERSION}`,
        );

        if (serverVersion < MUX_MIN_COMPATIBLE_VERSION) {
          log.error(
            () =>
              `Server protocol version ${serverVersion} is below minimum ${MUX_MIN_COMPATIBLE_VERSION}`,
          );
        } else if (serverVersion > MUX_PROTOCOL_VERSION) {
          log.warn(
            () =>
              `Server uses newer protocol (v${serverVersion}), client is v${MUX_PROTOCOL_VERSION}`,
          );
        }
      }
      return;
    }

    const sessionId = decodeSessionId(data, 1);
    const payload = data.slice(MUX_HEADER_SIZE);

    if (type === MUX_TYPE_RESYNC) {
      // Server is resyncing due to dropped frames - clear all terminals
      log.info(() => 'Resync: clearing terminals for buffer refresh');
      sessionTerminals.forEach((state) => {
        if (state.opened) {
          state.terminal.clear();
          state.terminal.write('\x1b[0m');
        }
      });
      pendingOutputFrames.clear();
      sessionsNeedingResync.clear();
      outputQueue.length = 0; // Clear pending queue too
      return;
    }

    if (type === MUX_TYPE_OUTPUT || type === MUX_TYPE_COMPRESSED_OUTPUT) {
      // Queue ALL output frames to guarantee strict ordering
      if (payload.length >= 4) {
        queueOutputFrame(sessionId, payload.slice(), type === MUX_TYPE_COMPRESSED_OUTPUT);
      }
    } else if (type === MUX_TYPE_FOREGROUND_CHANGE) {
      try {
        const jsonStr = new TextDecoder().decode(payload);
        const changePayload = JSON.parse(jsonStr) as ForegroundChangePayload;
        handleForegroundChange(sessionId, changePayload);
      } catch (e) {
        log.error(() => `Failed to parse foreground change: ${e}`);
      }
    } else if (type === MUX_TYPE_DATA_LOSS) {
      const droppedBytes =
        payload.length >= 4
          ? payload[0]! | (payload[1]! << 8) | (payload[2]! << 16) | (payload[3]! << 24)
          : 0;
      log.warn(
        () => `Data loss: session ${sessionId} dropped ${droppedBytes} bytes, requesting resync`,
      );
      sessionsNeedingResync.add(sessionId);
      requestBufferRefresh(sessionId);
    }
  };

  ws.onclose = (event) => {
    $muxWsConnected.set(false);

    // Log close reason
    if (event.code === WS_CLOSE_SERVER_SHUTDOWN) {
      log.info(() => 'Server shutting down, will reconnect');
    } else if (event.code !== 1000 && event.code !== 1001) {
      log.warn(() => `WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
    }

    scheduleMuxReconnect();
  };

  ws.onerror = (e) => {
    log.error(() => `WebSocket error: ${e}`);
  };
}

/**
 * Send a frame to the mux WebSocket with traffic tracking.
 */
function sendFrame(frame: Uint8Array): void {
  if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;
  addWsTxBytes(frame.byteLength);
  muxWs.send(frame);
}

/**
 * Send terminal input to server.
 * Buffers input when WebSocket is disconnected for replay on reconnect.
 */
export function sendInput(sessionId: string, data: string): void {
  if (!muxWs || muxWs.readyState !== WebSocket.OPEN) {
    // Buffer input during disconnection (prevents lost keystrokes during reconnect)
    if (pendingInputQueue.length < MAX_PENDING_INPUT) {
      pendingInputQueue.push({ sessionId, data });
    }
    return;
  }

  const payload = new TextEncoder().encode(data);
  const frame = new Uint8Array(MUX_HEADER_SIZE + payload.length);
  frame[0] = MUX_TYPE_INPUT;
  encodeSessionId(frame, 1, sessionId);
  frame.set(payload, MUX_HEADER_SIZE);
  sendFrame(frame);
}

/**
 * Flush any input buffered during WebSocket disconnection.
 */
function flushPendingInput(): void {
  while (pendingInputQueue.length > 0) {
    const item = pendingInputQueue.shift()!;
    sendInput(item.sessionId, item.data);
  }
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
  sendFrame(frame);

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
  sendFrame(frame);
}

/**
 * Send active session hint to server for priority delivery.
 */
export function sendActiveSessionHint(sessionId: string | null): void {
  if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;

  const frame = new Uint8Array(MUX_HEADER_SIZE);
  frame[0] = MUX_TYPE_ACTIVE_HINT;
  if (sessionId) {
    encodeSessionId(frame, 1, sessionId);
  }
  sendFrame(frame);
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
 * Schedule mux WebSocket reconnection.
 */
export function scheduleMuxReconnect(): void {
  scheduleReconnect(connectMuxWebSocket, setMuxReconnectTimer, muxReconnectTimer);
}

/**
 * Write output frame to terminal (used by manager.ts for replay).
 */
export function writeOutputFrame(
  sessionId: string,
  state: TerminalState,
  payload: Uint8Array,
): void {
  const frame = parseOutputFrame(payload);
  writeToTerminal(sessionId, state, frame.cols, frame.rows, frame.data);
}
