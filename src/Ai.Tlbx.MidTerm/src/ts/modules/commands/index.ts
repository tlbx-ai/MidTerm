/**
 * Commands Module
 *
 * Script-based command buttons with floating xterm.js output overlay.
 */

import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { createCommandsPanel, refreshCommandsPanel, destroyCommandsPanel } from './commandsPanel';
export { hiddenSessionIds } from '../../state';

const log = createLogger('commands');

const initializedSessions = new Set<string>();

export function initCommandsPanel(): void {
  onTabActivated('commands', (sessionId, panel) => {
    if (!initializedSessions.has(sessionId)) {
      initializedSessions.add(sessionId);
      createCommandsPanel(panel, sessionId);
    }
    refreshCommandsPanel(sessionId);
  });

  onTabDeactivated('commands', (_sessionId) => {
    // Nothing to clean up on deactivation
  });

  log.info(() => 'Commands panel initialized');
}

export function destroyCommandsSession(sessionId: string): void {
  destroyCommandsPanel(sessionId);
  initializedSessions.delete(sessionId);
}
