/**
 * Commands Module
 *
 * Script-based command buttons with floating xterm.js output overlay.
 */

import { createLogger } from '../logging';
import { onSidebarToggle } from '../sessionTabs';
import { destroyCommandsPanel } from './commandsPanel';
import { toggleCommandsDock, closeCommandsDock, setupDockResize } from './dock';
export { hiddenSessionIds } from '../../state';
export { closeCommandsDock } from './dock';

const log = createLogger('commands');

export function initCommandsPanel(): void {
  onSidebarToggle('commands', (sessionId) => {
    toggleCommandsDock(sessionId);
  });

  document.getElementById('cmd-dock-close')?.addEventListener('click', closeCommandsDock);

  setupDockResize();

  log.info(() => 'Commands panel initialized');
}

export function destroyCommandsSession(sessionId: string): void {
  destroyCommandsPanel(sessionId);
}
