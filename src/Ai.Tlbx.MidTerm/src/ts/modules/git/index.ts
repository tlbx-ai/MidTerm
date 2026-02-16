/**
 * Git Module
 *
 * VS Code-like git integration as a sidebar dock.
 * Provides a live status indicator in the IDE bar and a full
 * git panel in a right-side dock.
 */

import { createLogger } from '../logging';
import { setGitClickHandler, updateAllGitIndicators } from '../sessionTabs';
import { $activeSessionId } from '../../stores';
import { updateGitStatus, destroyGitPanel } from './gitPanel';
import { setGitStatusCallback, unsubscribeFromSession } from './gitChannel';
import { toggleGitDock, closeGitDock, setupGitDockResize } from './gitDock';
import { registerGitDockCloser } from '../commands/dock';
import type { GitStatusResponse } from './types';

const log = createLogger('git');

const cachedStatuses = new Map<string, GitStatusResponse>();

export function initGitPanel(): void {
  setGitStatusCallback((sessionId, status) => {
    cachedStatuses.set(sessionId, status);
    updateGitStatus(sessionId, status);

    const activeId = $activeSessionId.get();
    if (activeId === sessionId) {
      updateAllGitIndicators(status);
    }
  });

  $activeSessionId.subscribe((sessionId) => {
    if (!sessionId) {
      updateAllGitIndicators(null);
      return;
    }
    const cached = cachedStatuses.get(sessionId);
    updateAllGitIndicators(cached ?? null);
  });

  setGitClickHandler(() => {
    const sessionId = $activeSessionId.get();
    if (sessionId) {
      toggleGitDock(sessionId);
    }
  });

  document.getElementById('git-dock-close')?.addEventListener('click', closeGitDock);

  registerGitDockCloser(closeGitDock);
  setupGitDockResize();

  log.info(() => 'Git panel initialized');
}

export { connectGitWebSocket, disconnectGitWebSocket } from './gitChannel';

export function destroyGitSession(sessionId: string): void {
  unsubscribeFromSession(sessionId);
  destroyGitPanel(sessionId);
  cachedStatuses.delete(sessionId);
}
