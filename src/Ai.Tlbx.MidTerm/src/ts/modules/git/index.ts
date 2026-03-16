/**
 * Git Module
 *
 * VS Code-like git integration as a sidebar dock.
 * Provides a live status indicator in the IDE bar and a full
 * git panel in a right-side dock.
 */

import { createLogger } from '../logging';
import { setGitClickHandler, updateGitIndicatorForSession } from '../sessionTabs';
import { $activeSessionId } from '../../stores';
import { addProcessStateListener } from '../process';
import { updateGitStatus, destroyGitPanel } from './gitPanel';
import {
  setGitStatusCallback,
  subscribeToSession,
  unsubscribeFromSession,
  triggerGitFallback,
} from './gitChannel';
import { toggleGitDock, closeGitDock, setupGitDockResize } from './gitDock';
import { registerGitDockCloser } from '../commands/dock';
import type { GitStatusResponse } from './types';
import type { GitDiagEvent } from './gitChannel';

const log = createLogger('git');

const cachedStatuses = new Map<string, GitStatusResponse>();
const sessionCwds = new Map<string, string>();
let previousSessionId: string | null = null;

export type { GitDiagEvent };

export function initGitPanel(): void {
  setGitStatusCallback((sessionId, status) => {
    cachedStatuses.set(sessionId, status);
    updateGitStatus(sessionId, status);
    updateGitIndicatorForSession(sessionId, status);
  });

  $activeSessionId.subscribe((sessionId) => {
    if (previousSessionId && previousSessionId !== sessionId) {
      unsubscribeFromSession(previousSessionId);
    }
    previousSessionId = sessionId ?? null;

    if (!sessionId) {
      return;
    }
    subscribeToSession(sessionId);
    const cached = cachedStatuses.get(sessionId);
    updateGitIndicatorForSession(sessionId, cached ?? null);
  });

  addProcessStateListener((sessionId, state) => {
    const oldCwd = sessionCwds.get(sessionId);
    const newCwd = state.foregroundCwd;

    if (!newCwd || newCwd === oldCwd) return;

    sessionCwds.set(sessionId, newCwd);

    if (oldCwd) {
      emitCwdDiag(sessionId, oldCwd, newCwd);
      cachedStatuses.delete(sessionId);
      updateGitIndicatorForSession(sessionId, null);
      triggerGitFallback(sessionId);
    }
  });

  setGitClickHandler(() => {
    const sessionId = $activeSessionId.get();
    if (sessionId) {
      toggleGitDock(sessionId);
    }
  });

  registerGitDockCloser(closeGitDock);
  setupGitDockResize();

  log.info(() => 'Git panel initialized');
}

let cwdDiagCb: ((event: GitDiagEvent) => void) | null = null;

export function setGitCwdDiagCallback(cb: ((event: GitDiagEvent) => void) | null): void {
  cwdDiagCb = cb;
}

function emitCwdDiag(sessionId: string, oldCwd: string, newCwd: string): void {
  cwdDiagCb?.({
    type: 'cwd-change',
    detail: `${sessionId.substring(0, 8)}: ${oldCwd} → ${newCwd}`,
    timestamp: Date.now(),
  });
}

export {
  connectGitWebSocket,
  disconnectGitWebSocket,
  setGitDiagCallback,
  getGitWsState,
  getSubscribedSessions,
} from './gitChannel';

export function destroyGitSession(sessionId: string): void {
  unsubscribeFromSession(sessionId);
  destroyGitPanel(sessionId);
  cachedStatuses.delete(sessionId);
  sessionCwds.delete(sessionId);
  if (previousSessionId === sessionId) {
    previousSessionId = null;
  }
}
