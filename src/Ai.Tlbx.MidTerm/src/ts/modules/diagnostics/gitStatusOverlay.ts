/**
 * Git Status Overlay Module
 *
 * Floating overlay on the terminal showing real-time git diagnostics:
 * WebSocket state, subscribed sessions, branch/status summary,
 * and a color-coded event log. Toggled via Settings > Diagnostics.
 */

import { setGitDiagCallback, getGitWsState, getSubscribedSessions } from '../git';
import { setGitCwdDiagCallback } from '../git';
import { $activeSessionId } from '../../stores';
import { sessionTerminals } from '../../state';
import type { GitDiagEvent } from '../git';

let overlayEl: HTMLDivElement | null = null;
let enabled = false;
let currentSessionId: string | null = null;
let unsubscribeSession: (() => void) | null = null;

const MAX_EVENTS = 50;
const eventLog: GitDiagEvent[] = [];

let headerEl: HTMLDivElement | null = null;
let logEl: HTMLDivElement | null = null;

export function enableGitStatusOverlay(): void {
  if (enabled) return;
  enabled = true;

  const diagHandler = (event: GitDiagEvent): void => {
    addEvent(event);
  };
  setGitDiagCallback(diagHandler);
  setGitCwdDiagCallback(diagHandler);

  ensureOverlay();
  attachToActiveSession();
  updateHeader();

  unsubscribeSession = $activeSessionId.subscribe(() => {
    attachToActiveSession();
    updateHeader();
  });
}

export function disableGitStatusOverlay(): void {
  if (!enabled) return;
  enabled = false;
  setGitDiagCallback(null);
  setGitCwdDiagCallback(null);
  removeOverlay();
  if (unsubscribeSession) {
    unsubscribeSession();
    unsubscribeSession = null;
  }
}

export function isGitStatusOverlayEnabled(): boolean {
  return enabled;
}

function ensureOverlay(): void {
  if (overlayEl) return;

  overlayEl = document.createElement('div');
  overlayEl.className = 'git-status-overlay';

  headerEl = document.createElement('div');
  headerEl.className = 'git-overlay-header';
  overlayEl.appendChild(headerEl);

  logEl = document.createElement('div');
  logEl.className = 'git-overlay-log';
  overlayEl.appendChild(logEl);

  for (const event of eventLog) {
    appendEventRow(event);
  }
}

function removeOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  headerEl = null;
  logEl = null;
  currentSessionId = null;
}

function attachToActiveSession(): void {
  if (!overlayEl) return;
  const sessionId = $activeSessionId.get();
  if (!sessionId) return;

  if (currentSessionId === sessionId && overlayEl.parentElement) return;

  const state = sessionTerminals.get(sessionId);
  if (!state) return;

  overlayEl.remove();
  state.container.appendChild(overlayEl);
  currentSessionId = sessionId;
}

function updateHeader(): void {
  if (!headerEl) return;

  const wsState = getGitWsState();
  const subs = getSubscribedSessions();
  const wsColor = wsState === 'open' ? '#4ec9b0' : '#f44747';

  headerEl.innerHTML =
    `<span style="color:${wsColor}">WS: ${wsState}</span> ` +
    `<span style="color:#569cd6">Subs: ${subs.length}</span>`;
}

function addEvent(event: GitDiagEvent): void {
  eventLog.push(event);
  if (eventLog.length > MAX_EVENTS) {
    eventLog.shift();
    if (logEl && logEl.firstChild) {
      logEl.removeChild(logEl.firstChild);
    }
  }

  updateHeader();
  appendEventRow(event);
}

function appendEventRow(event: GitDiagEvent): void {
  if (!logEl) return;

  const row = document.createElement('div');
  row.className = 'git-overlay-event';

  const time = new Date(event.timestamp);
  const ts = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;

  const color = getEventColor(event.type);
  row.innerHTML = `<span style="color:#666">${ts}</span> <span style="color:${color}">${event.type}</span> ${event.detail}`;
  logEl.appendChild(row);

  logEl.scrollTop = logEl.scrollHeight;
}

function getEventColor(type: string): string {
  switch (type) {
    case 'ws-open':
    case 'status':
    case 'fallback-ok':
      return '#4ec9b0';
    case 'ws-close':
    case 'ws-error':
    case 'fallback-err':
      return '#f44747';
    case 'subscribe':
      return '#569cd6';
    case 'fallback':
    case 'cwd-change':
      return '#dcdcaa';
    case 'unsubscribe':
    case 'cache-clear':
      return '#808080';
    default:
      return '#d4d4d4';
  }
}
