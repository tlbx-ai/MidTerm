/**
 * Sidebar Updater Module
 *
 * Keeps the sidebar tree in sync with session, layout, hub, and settings changes.
 */

import { $sessions, $activeSessionId, $layout, $currentSettings } from '../../stores';
import type { Session } from '../../types';
import { createLogger } from '../logging';
import {
  applySessionFilterSettingChange,
  isSessionFilterActive,
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
} from './spacesTreeSidebar';
import { syncSidebarSessionDisplayText } from './spacesTreeSidebarDisplay';
import { getSidebarFastPathSessionUpdates } from './sidebarSessionDiff';

const log = createLogger('sidebarUpdater');

let initialized = false;
let unsubscribeSessions: (() => void) | null = null;
let unsubscribeActiveSession: (() => void) | null = null;
let unsubscribeLayout: (() => void) | null = null;
let unsubscribeSettings: (() => void) | null = null;
let previousSessions: Record<string, Session> | null = null;

function syncSessionFastPathUpdates(sessions: Record<string, Session>): boolean {
  if (!previousSessions || isSessionFilterActive()) {
    previousSessions = sessions;
    return false;
  }

  const titleUpdates = getSidebarFastPathSessionUpdates(previousSessions, sessions);
  previousSessions = sessions;
  if (titleUpdates === null) {
    return false;
  }

  for (const session of titleUpdates) {
    if (!syncSidebarSessionDisplayText(session)) {
      return false;
    }
  }

  updateMobileTitle();
  return true;
}

export function initializeSidebarUpdater(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  log.info(() => 'Initializing sidebar updater');

  previousSessions = null;
  unsubscribeSessions = $sessions.subscribe((sessions) => {
    if (syncSessionFastPathUpdates(sessions)) {
      return;
    }

    renderSessionList();
    updateEmptyState();
    updateMobileTitle();
  });

  unsubscribeActiveSession = $activeSessionId.subscribe(() => {
    renderSessionList();
    updateMobileTitle();
  });

  unsubscribeLayout = $layout.subscribe(() => {
    renderSessionList();
  });

  unsubscribeSettings = $currentSettings.subscribe(() => {
    applySessionFilterSettingChange();
    renderSessionList();
  });
}

export function cleanupSidebarUpdater(): void {
  unsubscribeSessions?.();
  unsubscribeSessions = null;
  unsubscribeActiveSession?.();
  unsubscribeActiveSession = null;
  unsubscribeLayout?.();
  unsubscribeLayout = null;
  unsubscribeSettings?.();
  unsubscribeSettings = null;
  initialized = false;
  previousSessions = null;
}
