/**
 * State Channel Module
 *
 * Manages the state WebSocket connection for real-time session list updates.
 * Handles automatic reconnection on disconnect.
 * Also provides bidirectional command channel for session CRUD operations.
 */

import type {
  Session,
  UpdateInfo,
  TerminalState,
  WsCommand,
  WsCommandPayload,
  WsCommandResponse,
} from '../../types';
import { scheduleReconnect, createWsUrl, closeWebSocket } from '../../utils';
import { createLogger } from '../logging';
import { initializeFromSession } from '../process';

const log = createLogger('state');
import {
  stateWs,
  stateReconnectTimer,
  sessionTerminals,
  newlyCreatedSessions,
  setStateWs,
  setStateReconnectTimer,
} from '../../state';

const COMMAND_TIMEOUT_MS = 30000;
const pendingCommands = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: number;
  }
>();
import {
  $settingsOpen,
  $stateWsConnected,
  $activeSessionId,
  $sessionList,
  $updateInfo,
  setSessions,
} from '../../stores';

// Forward declarations for functions from other modules
// These will be imported when those modules are created
let destroyTerminalForSession: (sessionId: string) => void = () => {};
let applyTerminalScaling: (sessionId: string, state: TerminalState) => void = () => {};
let createTerminalForSession: (
  sessionId: string,
  sessionInfo: Session | undefined,
) => void = () => {};
let updateEmptyState: () => void = () => {};
let selectSession: (
  sessionId: string,
  options?: { closeSettingsPanel?: boolean },
) => void = () => {};
let updateMobileTitle: () => void = () => {};
let renderUpdatePanel: () => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerStateCallbacks(callbacks: {
  destroyTerminalForSession?: (sessionId: string) => void;
  applyTerminalScaling?: (sessionId: string, state: TerminalState) => void;
  createTerminalForSession?: (sessionId: string, sessionInfo: Session | undefined) => void;
  updateEmptyState?: () => void;
  selectSession?: (sessionId: string, options?: { closeSettingsPanel?: boolean }) => void;
  updateMobileTitle?: () => void;
  renderUpdatePanel?: () => void;
}): void {
  if (callbacks.destroyTerminalForSession)
    destroyTerminalForSession = callbacks.destroyTerminalForSession;
  if (callbacks.applyTerminalScaling) applyTerminalScaling = callbacks.applyTerminalScaling;
  if (callbacks.createTerminalForSession)
    createTerminalForSession = callbacks.createTerminalForSession;
  if (callbacks.updateEmptyState) updateEmptyState = callbacks.updateEmptyState;
  if (callbacks.selectSession) selectSession = callbacks.selectSession;
  if (callbacks.updateMobileTitle) updateMobileTitle = callbacks.updateMobileTitle;
  if (callbacks.renderUpdatePanel) renderUpdatePanel = callbacks.renderUpdatePanel;
}

/**
 * Connect to the state WebSocket for real-time session updates.
 * Automatically reconnects with exponential backoff on disconnect.
 */
export function connectStateWebSocket(): void {
  closeWebSocket(stateWs, setStateWs);

  const ws = new WebSocket(createWsUrl('/ws/state'));
  setStateWs(ws);

  ws.onopen = () => {
    $stateWsConnected.set(true);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Handle command responses
      if (data.type === 'response') {
        handleCommandResponse(data as WsCommandResponse);
        return;
      }

      // Handle state updates
      const sessionList = data.sessions?.sessions ?? [];
      handleStateUpdate(sessionList);
      handleUpdateInfo(data.update);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(() => `Error parsing state: ${message}`);
    }
  };

  ws.onclose = () => {
    $stateWsConnected.set(false);

    // Reject all pending commands immediately (don't wait for timeout)
    pendingCommands.forEach((cmd, id) => {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Connection lost'));
      pendingCommands.delete(id);
    });

    scheduleStateReconnect();
  };

  ws.onerror = (e) => {
    log.error(() => `WebSocket error: ${e}`);
  };
}

/**
 * Handle session list updates from server.
 * Removes terminals for deleted sessions, updates dimensions, and manages selection.
 * Creates terminals proactively for all sessions so they receive data in the background.
 */
export function handleStateUpdate(newSessions: Session[]): void {
  // Remove terminals for deleted sessions
  const newIds = new Set(newSessions.map((s) => s.id));
  sessionTerminals.forEach((_, id) => {
    if (!newIds.has(id)) {
      destroyTerminalForSession(id);
      newlyCreatedSessions.delete(id);
    }
  });

  // Update dimensions and resize terminals when server dimensions change
  // Also create terminals proactively for sessions that don't have one yet
  // Initialize process state from session data (for reconnect scenarios)
  newSessions.forEach((session) => {
    // Initialize process monitor state from session data
    initializeFromSession(
      session.id,
      session.foregroundPid,
      session.foregroundName,
      session.foregroundCommandLine,
      session.currentDirectory,
    );

    const state = sessionTerminals.get(session.id);
    if (state && state.opened) {
      const dimensionsChanged =
        state.serverCols !== session.cols || state.serverRows !== session.rows;
      if (dimensionsChanged) {
        state.serverCols = session.cols;
        state.serverRows = session.rows;
        state.terminal.resize(session.cols, session.rows);
        applyTerminalScaling(session.id, state);
      }
    } else if (state) {
      state.serverCols = session.cols;
      state.serverRows = session.rows;
    } else {
      // Create terminal proactively - it will be hidden and ready for data
      createTerminalForSession(session.id, session);
    }
  });

  // Update store - sidebarUpdater subscription handles rendering
  setSessions(newSessions);
  updateEmptyState();

  // Auto-select first session if none active (but not if settings are open)
  const isSettingsOpen = $settingsOpen.get();
  const activeId = $activeSessionId.get();
  const sessionList = $sessionList.get();
  const firstSession = sessionList[0];
  if (!activeId && firstSession && !isSettingsOpen) {
    selectSession(firstSession.id, { closeSettingsPanel: false });
  }

  // Handle active session being deleted (but not if settings are open)
  if (activeId && !sessionList.find((s) => s.id === activeId)) {
    $activeSessionId.set(null);
    const nextSession = sessionList[0];
    if (nextSession && !isSettingsOpen) {
      selectSession(nextSession.id, { closeSettingsPanel: false });
    }
  }

  updateMobileTitle();
}

/**
 * Handle update info from server.
 * Updates the stored update info and renders the update panel.
 */
export function handleUpdateInfo(update: UpdateInfo | null): void {
  $updateInfo.set(update);
  renderUpdatePanel();
}

/**
 * Schedule state WebSocket reconnection.
 */
export function scheduleStateReconnect(): void {
  scheduleReconnect(connectStateWebSocket, setStateReconnectTimer, stateReconnectTimer);
}

// =============================================================================
// WebSocket Command API
// =============================================================================

/**
 * Handle command response from server.
 */
function handleCommandResponse(response: WsCommandResponse): void {
  const pending = pendingCommands.get(response.id);
  if (!pending) {
    log.verbose(() => `Received response for unknown command: ${response.id}`);
    return;
  }

  clearTimeout(pending.timeout);
  pendingCommands.delete(response.id);

  if (response.success) {
    pending.resolve(response.data);
  } else {
    pending.reject(new Error(response.error ?? 'Command failed'));
  }
}

/**
 * Send a command to the server over the state WebSocket.
 * Returns a promise that resolves with the response data or rejects on error.
 */
export async function sendCommand<T = unknown>(
  action: string,
  payload?: WsCommandPayload,
): Promise<T> {
  const ws = stateWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected');
  }

  const id = crypto.randomUUID();
  const command: WsCommand = {
    type: 'command',
    id,
    action,
    payload,
  };

  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command timed out: ${action}`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(id, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timeout,
    });

    try {
      ws.send(JSON.stringify(command));
    } catch (e) {
      clearTimeout(timeout);
      pendingCommands.delete(id);
      reject(e);
    }
  });
}

/**
 * Check if the state WebSocket is connected and ready for commands.
 */
export function isStateConnected(): boolean {
  return stateWs !== null && stateWs.readyState === WebSocket.OPEN;
}

/**
 * Persist session order to server.
 * Fire-and-forget - failures are logged but not thrown.
 */
export function persistSessionOrder(sessionIds: string[]): void {
  if (!isStateConnected()) return;

  sendCommand('session.reorder', { sessionIds }).catch((e) => {
    log.warn(() => `Failed to persist session order: ${e}`);
  });
}
