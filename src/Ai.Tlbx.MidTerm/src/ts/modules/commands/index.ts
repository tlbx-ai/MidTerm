/**
 * Commands Module
 *
 * Script-based command buttons with floating xterm.js output overlay.
 */

import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { createCommandsPanel, refreshCommandsPanel, destroyCommandsPanel } from './commandsPanel';
import { undockCommandsPanel, closeCommandsDock, setupDockResize } from './dock';
import { $commandsPanelDocked } from '../../stores';
export { hiddenSessionIds } from '../../state';
export { closeCommandsDock } from './dock';

const log = createLogger('commands');

const initializedSessions = new Set<string>();

export function initCommandsPanel(): void {
  onTabActivated('commands', (sessionId, panel) => {
    if ($commandsPanelDocked.get()) {
      undockCommandsPanel();
      return;
    }
    if (!initializedSessions.has(sessionId)) {
      initializedSessions.add(sessionId);
      createCommandsPanel(panel, sessionId);
    }
    refreshCommandsPanel(sessionId);
  });

  onTabDeactivated('commands', (_sessionId) => {
    // Nothing to clean up on deactivation
  });

  // Wire dock panel buttons
  document.getElementById('cmd-dock-undock')?.addEventListener('click', undockCommandsPanel);
  document.getElementById('cmd-dock-close')?.addEventListener('click', closeCommandsDock);

  setupDockResize();

  log.info(() => 'Commands panel initialized');
}

export function destroyCommandsSession(sessionId: string): void {
  destroyCommandsPanel(sessionId);
  initializedSessions.delete(sessionId);
}
