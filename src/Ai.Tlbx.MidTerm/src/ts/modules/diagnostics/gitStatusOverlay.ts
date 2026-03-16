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

  headerEl.replaceChildren(
    createToneSpan(
      `WS: ${wsState}`,
      wsState === 'open' ? 'git-overlay-tone-good' : 'git-overlay-tone-bad',
    ),
    createToneSpan(`Subs: ${subs.length}`, 'git-overlay-tone-info'),
  );
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

  const timestamp = document.createElement('span');
  timestamp.className = 'git-overlay-tone-time';
  timestamp.textContent = ts;

  const type = document.createElement('span');
  type.className = `git-overlay-event-type ${getEventToneClass(event.type)}`;
  type.textContent = event.type;

  row.appendChild(timestamp);
  row.appendChild(type);
  row.appendChild(document.createTextNode(` ${event.detail}`));
  logEl.appendChild(row);

  logEl.scrollTop = logEl.scrollHeight;
}

function getEventToneClass(type: string): string {
  switch (type) {
    case 'ws-open':
    case 'status':
    case 'fallback-ok':
      return 'git-overlay-tone-good';
    case 'ws-close':
    case 'ws-error':
    case 'fallback-err':
      return 'git-overlay-tone-bad';
    case 'subscribe':
      return 'git-overlay-tone-info';
    case 'fallback':
    case 'cwd-change':
      return 'git-overlay-tone-warn';
    case 'unsubscribe':
    case 'cache-clear':
      return 'git-overlay-tone-muted';
    default:
      return 'git-overlay-tone-default';
  }
}

function createToneSpan(text: string, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `git-overlay-segment ${className}`;
  span.textContent = text;
  return span;
}
