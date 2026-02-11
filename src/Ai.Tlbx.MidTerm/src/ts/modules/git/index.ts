/**
 * Git Module
 *
 * VS Code-like git integration for the Git tab.
 */

import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { createGitPanel, updateGitStatus, refreshGitPanel, destroyGitPanel } from './gitPanel';
import { setGitStatusCallback, subscribeToSession, unsubscribeFromSession } from './gitChannel';

const log = createLogger('git');

const initializedSessions = new Set<string>();

export function initGitPanel(): void {
  setGitStatusCallback((sessionId, status) => {
    updateGitStatus(sessionId, status);
  });

  onTabActivated('git', (sessionId, panel) => {
    if (!initializedSessions.has(sessionId)) {
      initializedSessions.add(sessionId);
      createGitPanel(panel, sessionId);
      subscribeToSession(sessionId);
    }
    refreshGitPanel(sessionId);
  });

  onTabDeactivated('git', (_sessionId) => {
    // Keep subscription active even when tab hidden
  });

  log.info(() => 'Git panel initialized');
}

export { connectGitWebSocket } from './gitChannel';

export function destroyGitSession(sessionId: string): void {
  unsubscribeFromSession(sessionId);
  destroyGitPanel(sessionId);
  initializedSessions.delete(sessionId);
}
