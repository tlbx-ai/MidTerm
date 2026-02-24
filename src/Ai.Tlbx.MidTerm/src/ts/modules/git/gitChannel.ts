/**
 * Git WebSocket Channel
 *
 * Manages real-time git status updates via WebSocket.
 */

import { createLogger } from '../logging';
import { ReconnectController, createWsUrl } from '../../utils';
import { fetchGitStatus } from './gitApi';
import type { GitWsMessage, GitStatusResponse } from './types';

const log = createLogger('gitChannel');
const gitReconnect = new ReconnectController();

let ws: WebSocket | null = null;
const subscribedSessions = new Set<string>();
let statusCallback: ((sessionId: string, status: GitStatusResponse) => void) | null = null;

export type GitDiagEvent = {
  type: string;
  detail: string;
  timestamp: number;
};

type GitDiagCallback = (event: GitDiagEvent) => void;
let diagCallback: GitDiagCallback | null = null;

const pendingFallbacks = new Map<string, number>();

function emitDiag(type: string, detail: string): void {
  diagCallback?.({ type, detail, timestamp: Date.now() });
}

export function setGitDiagCallback(cb: GitDiagCallback | null): void {
  diagCallback = cb;
}

export function getGitWsState(): string {
  if (!ws) return 'disconnected';
  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return 'connecting';
    case WebSocket.OPEN:
      return 'open';
    case WebSocket.CLOSING:
      return 'closing';
    case WebSocket.CLOSED:
      return 'closed';
    default:
      return 'unknown';
  }
}

export function getSubscribedSessions(): string[] {
  return Array.from(subscribedSessions);
}

export function setGitStatusCallback(
  cb: (sessionId: string, status: GitStatusResponse) => void,
): void {
  statusCallback = cb;
}

export function connectGitWebSocket(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(createWsUrl('/ws/git'));

  ws.onopen = () => {
    gitReconnect.reset();
    log.info(() => 'Git WebSocket connected');
    emitDiag('ws-open', 'connected');
    for (const sessionId of subscribedSessions) {
      sendSubscribe(sessionId);
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as GitWsMessage;
      if (msg.type === 'status' && msg.status && msg.sessionId) {
        cancelFallback(msg.sessionId);
        const summary = `${msg.status.branch} +${msg.status.staged?.length ?? 0} ~${msg.status.modified?.length ?? 0} ?${msg.status.untracked?.length ?? 0}`;
        emitDiag('status', `${msg.sessionId.substring(0, 8)}: ${summary}`);
        statusCallback?.(msg.sessionId, msg.status);
      }
    } catch (e) {
      log.error(() => `Failed to parse git WS message: ${String(e)}`);
    }
  };

  ws.onerror = () => {
    log.warn(() => 'Git WebSocket error');
    emitDiag('ws-error', 'connection error');
  };

  ws.onclose = () => {
    log.info(() => 'Git WebSocket closed');
    emitDiag('ws-close', 'disconnected');
    ws = null;
    if (subscribedSessions.size > 0) {
      gitReconnect.schedule(connectGitWebSocket);
    }
  };
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

function scheduleFallback(sessionId: string): void {
  cancelFallback(sessionId);
  const timer = window.setTimeout(() => {
    pendingFallbacks.delete(sessionId);
    emitDiag('fallback', `REST fallback for ${sessionId.substring(0, 8)}`);
    void fetchGitStatus(sessionId).then((status) => {
      if (status) {
        emitDiag('fallback-ok', status.branch);
        statusCallback?.(sessionId, status);
      } else {
        emitDiag('fallback-err', `no status for ${sessionId.substring(0, 8)}`);
      }
    });
  }, 3000);
  pendingFallbacks.set(sessionId, timer);
}

function cancelFallback(sessionId: string): void {
  const timer = pendingFallbacks.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingFallbacks.delete(sessionId);
  }
}

export function triggerGitFallback(sessionId: string): void {
  scheduleFallback(sessionId);
}

export function disconnectGitWebSocket(): void {
  gitReconnect.cancel();
  for (const timer of pendingFallbacks.values()) {
    clearTimeout(timer);
  }
  pendingFallbacks.clear();
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  log.info(() => 'Git WebSocket disconnected (IDE mode off)');
}

export function subscribeToSession(sessionId: string): void {
  subscribedSessions.add(sessionId);
  emitDiag('subscribe', sessionId.substring(0, 8));
  sendSubscribe(sessionId);
  scheduleFallback(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectGitWebSocket();
  }
}

export function unsubscribeFromSession(sessionId: string): void {
  subscribedSessions.delete(sessionId);
  cancelFallback(sessionId);
  emitDiag('unsubscribe', sessionId.substring(0, 8));
  sendUnsubscribe(sessionId);
}
