/**
 * Sidebar Updater Module
 *
 * Keeps the sidebar tree in sync with session, layout, hub, and settings changes.
 */

import { $sessions, $activeSessionId, $currentSettings, $layout } from '../../stores';
import type { MidTermSettingsPublic, Session } from '../../types';
import { createLogger } from '../logging';
import {
  applySessionFilterSettingChange,
  isSessionFilterActive,
  renderSessionList,
  syncSidebarSessionProcessInfo,
  updateEmptyState,
  updateMobileTitle,
} from './spacesTreeSidebar';
import {
  syncSidebarActiveSessionState,
  syncSidebarSessionDisplayText,
} from './spacesTreeSidebarDisplay';
import { getSidebarFastPathSessionUpdates } from './sidebarSessionDiff';

const log = createLogger('sidebarUpdater');

let initialized = false;
let unsubscribeSessions: (() => void) | null = null;
let unsubscribeActiveSession: (() => void) | null = null;
let unsubscribeSettings: (() => void) | null = null;
let unsubscribeLayout: (() => void) | null = null;
let previousSessions: Record<string, Session> | null = null;
let previousSidebarSettingsSignature: string | null = null;

function getSidebarSettingsSignature(settings: MidTermSettingsPublic | null): string {
  return [
    settings?.showSidebarSessionFilter ?? '',
    settings?.showBookmarks ?? '',
    settings?.allowAdHocSessionBookmarks ?? '',
    settings?.language ?? '',
  ].join('\u001f');
}

function syncSessionFastPathUpdates(sessions: Record<string, Session>): boolean {
  if (!previousSessions || isSessionFilterActive()) {
    previousSessions = sessions;
    return false;
  }

  const contentUpdates = getSidebarFastPathSessionUpdates(previousSessions, sessions);
  previousSessions = sessions;
  if (contentUpdates === null) {
    return false;
  }

  for (const session of contentUpdates) {
    if (!syncSidebarSessionDisplayText(session)) {
      return false;
    }
    if (!syncSidebarSessionProcessInfo(session.id)) {
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

  unsubscribeActiveSession = $activeSessionId.subscribe((activeSessionId) => {
    if (!syncSidebarActiveSessionState(activeSessionId)) {
      renderSessionList();
    }
    updateMobileTitle();
  });

  unsubscribeLayout = $layout.subscribe(() => {
    renderSessionList();
    updateMobileTitle();
  });

  unsubscribeSettings = $currentSettings.subscribe((settings) => {
    const nextSignature = getSidebarSettingsSignature(settings);
    if (previousSidebarSettingsSignature === nextSignature) {
      return;
    }
    previousSidebarSettingsSignature = nextSignature;
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
  previousSidebarSettingsSignature = null;
}
