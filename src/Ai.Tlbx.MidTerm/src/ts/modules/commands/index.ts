/**
 * Commands Module
 *
 * Script-based command buttons with floating xterm.js output overlay.
 */

import { createLogger } from '../logging';
import { setCommandsClickHandler } from '../sessionTabs';
import { $activeSessionId } from '../../stores';
import { destroyCommandsPanel } from './commandsPanel';
import { toggleCommandsDock, closeCommandsDock, setupDockResize } from './dock';
export { hiddenSessionIds } from '../../state';
export { closeCommandsDock } from './dock';

const log = createLogger('commands');

export function initCommandsPanel(): void {
  setCommandsClickHandler(() => {
    const sessionId = $activeSessionId.get();
    if (sessionId) {
      toggleCommandsDock(sessionId);
    }
  });

  document.getElementById('cmd-dock-close')?.addEventListener('click', closeCommandsDock);

  setupDockResize();

  log.info(() => 'Commands panel initialized');
}

export function destroyCommandsSession(sessionId: string): void {
  destroyCommandsPanel(sessionId);
}
