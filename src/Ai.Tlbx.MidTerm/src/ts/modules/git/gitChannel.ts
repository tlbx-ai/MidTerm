/**
 * Git WebSocket Channel
 *
 * Manages real-time git status updates via WebSocket.
 */

import { createLogger } from '../logging';
import { createWsUrl } from '../../utils';
import type { GitWsMessage, GitStatusResponse } from './types';

const log = createLogger('gitChannel');

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
const subscribedSessions = new Set<string>();
let statusCallback: ((sessionId: string, status: GitStatusResponse) => void) | null = null;

export function setGitStatusCallback(
  cb: (sessionId: string, status: GitStatusResponse) => void,
): void {
  statusCallback = cb;
}

export function connectGitWebSocket(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(createWsUrl('/ws/git'));

  ws.onopen = () => {
    log.info(() => 'Git WebSocket connected');
    for (const sessionId of subscribedSessions) {
      sendSubscribe(sessionId);
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as GitWsMessage;
      if (msg.type === 'status' && msg.status && msg.sessionId) {
        statusCallback?.(msg.sessionId, msg.status);
      }
    } catch (e) {
      log.error(() => `Failed to parse git WS message: ${e}`);
    }
  };

  ws.onerror = () => {
    log.warn(() => 'Git WebSocket error');
  };

  ws.onclose = () => {
    log.info(() => 'Git WebSocket closed');
    ws = null;
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (subscribedSessions.size > 0) {
      connectGitWebSocket();
    }
  }, 3000);
}

function sendSubscribe(sessionId: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  }
}

function sendUnsubscribe(sessionId: string): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'unsubscribe', sessionId }));
  }
}

export function disconnectGitWebSocket(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  log.info(() => 'Git WebSocket disconnected (IDE mode off)');
}

export function subscribeToSession(sessionId: string): void {
  subscribedSessions.add(sessionId);
  sendSubscribe(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectGitWebSocket();
  }
}

export function unsubscribeFromSession(sessionId: string): void {
  subscribedSessions.delete(sessionId);
  sendUnsubscribe(sessionId);
}
