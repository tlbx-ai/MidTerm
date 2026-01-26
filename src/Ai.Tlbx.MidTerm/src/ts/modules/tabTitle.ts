/**
 * Tab Title Module
 *
 * Manages browser tab title updates based on user settings.
 * Supports multiple title modes: hostname, static, session name, terminal title, foreground process.
 */

import type { Session, TabTitleMode, ProcessState } from '../types';
import { $activeSession, $activeSessionId, $currentSettings, $serverHostname } from '../stores';
import { addProcessStateListener } from './process';

/**
 * Get the current tab title based on mode and active session
 */
function getTabTitle(mode: TabTitleMode, session: Session | null): string {
  const base = 'MidTerm';

  switch (mode) {
    case 'static':
      return base;

    case 'hostname': {
      const hostname = $serverHostname.get();
      return hostname ? `${base} - ${hostname}` : base;
    }

    case 'sessionName':
      return session?.name ? `${base} - ${session.name}` : base;

    case 'terminalTitle':
      return session?.terminalTitle ? `${base} - ${session.terminalTitle}` : base;

    case 'foregroundProcess':
      return session?.foregroundName ? `${base} - ${session.foregroundName}` : base;

    default:
      return base;
  }
}

/**
 * Update the browser tab title based on current settings and session
 */
export function updateTabTitle(): void {
  const mode = $currentSettings.get()?.tabTitleMode ?? 'hostname';
  const session = $activeSession.get();
  const title = getTabTitle(mode, session);

  if (document.title !== title) {
    document.title = title;
  }
}

/**
 * Initialize tab title subscriptions
 */
export function initTabTitle(): void {
  // React to active session changes (covers session switch + data sync)
  $activeSession.subscribe(() => {
    updateTabTitle();
  });

  // React to immediate foreground process changes (fast path for "foregroundProcess" mode)
  addProcessStateListener((sessionId: string, _state: ProcessState) => {
    if (sessionId === $activeSessionId.get()) {
      updateTabTitle();
    }
  });

  // Initial update
  updateTabTitle();
}
