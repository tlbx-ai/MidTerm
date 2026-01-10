/**
 * Logs Channel Module
 *
 * WebSocket connection for streaming backend logs (mt.exe and mthost sessions).
 */

import { createLogger } from '../logging';
import { RECONNECT_DELAY } from '../../constants';

const log = createLogger('logs-ws');

export interface ServerLogEntry {
  messageType: 'log';
  source: string;
  sessionId?: string;
  timestamp: string;
  level: string;
  message: string;
}

export interface LogHistoryResponse {
  messageType: 'history';
  source: string;
  sessionId?: string;
  entries: ServerLogEntry[];
  hasMore: boolean;
}

export interface LogSessionInfo {
  id: string;
  active: boolean;
  logCount: number;
}

export interface LogSessionsResponse {
  messageType: 'sessions';
  sessions: LogSessionInfo[];
}

interface PingMessage {
  messageType: 'ping';
}

type LogMessage = ServerLogEntry | LogHistoryResponse | LogSessionsResponse | PingMessage;

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

// Callbacks
let onLogEntry: ((entry: ServerLogEntry) => void) | null = null;
let onHistory: ((response: LogHistoryResponse) => void) | null = null;
let onSessions: ((response: LogSessionsResponse) => void) | null = null;
let onConnectionChange: ((connected: boolean) => void) | null = null;

/**
 * Set callback for individual log entries
 */
export function setOnLogEntry(callback: (entry: ServerLogEntry) => void): void {
  onLogEntry = callback;
}

/**
 * Set callback for history responses
 */
export function setOnHistory(callback: (response: LogHistoryResponse) => void): void {
  onHistory = callback;
}

/**
 * Set callback for sessions list responses
 */
export function setOnSessions(callback: (response: LogSessionsResponse) => void): void {
  onSessions = callback;
}

/**
 * Set callback for connection state changes
 */
export function setOnConnectionChange(callback: (connected: boolean) => void): void {
  onConnectionChange = callback;
}

/**
 * Connect to the logs WebSocket
 */
export function connectLogsWebSocket(): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  if (ws) {
    ws.onclose = null;
    ws.close();
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws/logs`);

  ws.onopen = () => {
    log.info(() => 'Connected to logs WebSocket');
    onConnectionChange?.(true);
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data) as LogMessage;
      handleMessage(message);
    } catch (e) {
      log.error(() => `Failed to parse log message: ${e}`);
    }
  };

  ws.onclose = () => {
    log.info(() => 'Logs WebSocket closed');
    onConnectionChange?.(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    log.error(() => 'Logs WebSocket error');
  };
}

/**
 * Disconnect from the logs WebSocket
 */
export function disconnectLogsWebSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
}

/**
 * Subscribe to mt.exe logs
 */
export function subscribeMt(): void {
  sendMessage({ action: 'subscribe', type: 'mt' });
}

/**
 * Unsubscribe from mt.exe logs
 */
export function unsubscribeMt(): void {
  sendMessage({ action: 'unsubscribe', type: 'mt' });
}

/**
 * Subscribe to a session's logs
 */
export function subscribeSession(sessionId: string): void {
  sendMessage({ action: 'subscribe', type: 'mthost', sessionId });
}

/**
 * Unsubscribe from a session's logs
 */
export function unsubscribeSession(sessionId: string): void {
  sendMessage({ action: 'unsubscribe', type: 'mthost', sessionId });
}

/**
 * Request log history
 */
export function requestHistory(type: 'mt' | 'mthost', sessionId?: string, limit = 100): void {
  sendMessage({ action: 'history', type, sessionId, limit });
}

/**
 * Request list of sessions with logs
 */
export function requestSessions(): void {
  sendMessage({ action: 'sessions' });
}

/**
 * Check if connected
 */
export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function sendMessage(message: object): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

function handleMessage(message: LogMessage): void {
  switch (message.messageType) {
    case 'log':
      onLogEntry?.(message);
      break;
    case 'history':
      onHistory?.(message);
      break;
    case 'sessions':
      onSessions?.(message);
      break;
    case 'ping':
      // Server keepalive - no action needed
      break;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectLogsWebSocket();
  }, RECONNECT_DELAY);
}
