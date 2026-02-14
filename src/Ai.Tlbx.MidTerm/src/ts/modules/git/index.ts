/**
 * Git Module
 *
 * VS Code-like git integration as a sidebar dock.
 */

import { createLogger } from '../logging';
import { onSidebarToggle } from '../sessionTabs';
import { updateGitStatus, destroyGitPanel } from './gitPanel';
import { setGitStatusCallback, unsubscribeFromSession } from './gitChannel';
import { toggleGitDock, closeGitDock, setupGitDockResize } from './gitDock';
import { registerGitDockCloser } from '../commands/dock';

const log = createLogger('git');

export function initGitPanel(): void {
  setGitStatusCallback((sessionId, status) => {
    updateGitStatus(sessionId, status);
  });

  onSidebarToggle('git', (sessionId) => {
    toggleGitDock(sessionId);
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
}
