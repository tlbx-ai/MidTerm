/**
 * State Channel Module
 *
 * Manages the state WebSocket connection for real-time session list updates.
 * Handles automatic reconnection with exponential backoff.
 */

import type { Session, UpdateInfo, TerminalState } from '../../types';
import { INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY } from '../../constants';
import { scheduleReconnect } from '../../utils';
import { createLogger } from '../logging';

const log = createLogger('state');
import {
  sessions,
  activeSessionId,
  settingsOpen,
  stateWs,
  stateReconnectTimer,
  stateReconnectDelay,
  stateWsConnected,
  muxWsConnected,
  sessionTerminals,
  newlyCreatedSessions,
  setStateWs,
  setStateReconnectTimer,
  setStateReconnectDelay,
  setStateWsConnected,
  setSessions,
  setActiveSessionId,
  setUpdateInfo
} from '../../state';

// Forward declarations for functions from other modules
// These will be imported when those modules are created
let destroyTerminalForSession: (sessionId: string) => void = () => {};
let applyTerminalScaling: (sessionId: string, state: TerminalState) => void = () => {};
let createTerminalForSession: (sessionId: string, sessionInfo: Session | undefined) => void = () => {};
let renderSessionList: () => void = () => {};
let updateEmptyState: () => void = () => {};
let selectSession: (sessionId: string) => void = () => {};
let updateMobileTitle: () => void = () => {};
let renderUpdatePanel: () => void = () => {};

/**
 * Register callbacks from other modules
 */
export function registerStateCallbacks(callbacks: {
  destroyTerminalForSession?: (sessionId: string) => void;
  applyTerminalScaling?: (sessionId: string, state: TerminalState) => void;
  createTerminalForSession?: (sessionId: string, sessionInfo: Session | undefined) => void;
  renderSessionList?: () => void;
  updateEmptyState?: () => void;
  selectSession?: (sessionId: string) => void;
  updateMobileTitle?: () => void;
  renderUpdatePanel?: () => void;
}): void {
  if (callbacks.destroyTerminalForSession) destroyTerminalForSession = callbacks.destroyTerminalForSession;
  if (callbacks.applyTerminalScaling) applyTerminalScaling = callbacks.applyTerminalScaling;
  if (callbacks.createTerminalForSession) createTerminalForSession = callbacks.createTerminalForSession;
  if (callbacks.renderSessionList) renderSessionList = callbacks.renderSessionList;
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
  // Close existing WebSocket before creating new one
  if (stateWs) {
    stateWs.onclose = null; // Prevent reconnect loop
    stateWs.close();
    setStateWs(null);
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/ws/state`);
  setStateWs(ws);

  ws.onopen = () => {
    setStateReconnectDelay(INITIAL_RECONNECT_DELAY);
    setStateWsConnected(true);
    updateConnectionStatus();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const sessionList = data.sessions?.sessions ?? [];
      handleStateUpdate(sessionList);
      handleUpdateInfo(data.update);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(() => `Error parsing state: ${message}`);
    }
  };

  ws.onclose = () => {
    setStateWsConnected(false);
    updateConnectionStatus();
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
  const newIds = new Set(newSessions.map(s => s.id));
  sessionTerminals.forEach((_, id) => {
    if (!newIds.has(id)) {
      destroyTerminalForSession(id);
      newlyCreatedSessions.delete(id);
    }
  });

  // Update dimensions and resize terminals when server dimensions change
  // Also create terminals proactively for sessions that don't have one yet
  newSessions.forEach((session) => {
    const state = sessionTerminals.get(session.id);
    if (state && state.opened) {
      const dimensionsChanged = state.serverCols !== session.cols || state.serverRows !== session.rows;
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

  setSessions(newSessions);
  renderSessionList();
  updateEmptyState();

  // Auto-select first session if none active (but not if settings are open)
  const firstSession = sessions[0];
  if (!activeSessionId && firstSession && !settingsOpen) {
    selectSession(firstSession.id);
  }

  // Handle active session being deleted (but not if settings are open)
  if (activeSessionId && !sessions.find(s => s.id === activeSessionId)) {
    setActiveSessionId(null);
    const nextSession = sessions[0];
    if (nextSession && !settingsOpen) {
      selectSession(nextSession.id);
    }
  }

  updateMobileTitle();
}

/**
 * Handle update info from server.
 * Updates the stored update info and renders the update panel.
 */
export function handleUpdateInfo(update: UpdateInfo | null): void {
  setUpdateInfo(update);
  renderUpdatePanel();
}

/**
 * Schedule state WebSocket reconnection with exponential backoff.
 */
export function scheduleStateReconnect(): void {
  scheduleReconnect(
    stateReconnectDelay,
    MAX_RECONNECT_DELAY,
    connectStateWebSocket,
    setStateReconnectDelay,
    setStateReconnectTimer,
    stateReconnectTimer
  );
}

/**
 * Update the connection status indicator in the UI.
 */
export function updateConnectionStatus(): void {
  const indicator = document.getElementById('connection-status');
  if (!indicator) return;

  let status: string;
  let text: string;

  if (stateWsConnected && muxWsConnected) {
    status = 'connected';
    text = '';
  } else if (!stateWsConnected && !muxWsConnected) {
    status = 'disconnected';
    text = 'Server disconnected';
  } else {
    status = 'reconnecting';
    text = 'Reconnecting...';
  }

  indicator.className = `connection-status ${status}`;
  indicator.textContent = text;
}
