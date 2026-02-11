/**
 * Commands Module
 *
 * User-defined command buttons with streaming output.
 */

import { createLogger } from '../logging';
import { onTabActivated, onTabDeactivated } from '../sessionTabs';
import { createCommandsPanel, refreshCommandsPanel, destroyCommandsPanel } from './commandsPanel';

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
