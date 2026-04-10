/**
 * Sidebar Updater Module
 *
 * Keeps the sidebar tree in sync with session, layout, hub, and settings changes.
 */

import { $sessions, $activeSessionId, $layout, $currentSettings } from '../../stores';
import { createLogger } from '../logging';
import {
  applySessionFilterSettingChange,
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
} from './spacesTreeSidebar';

const log = createLogger('sidebarUpdater');

let initialized = false;
let unsubscribeSessions: (() => void) | null = null;
let unsubscribeActiveSession: (() => void) | null = null;
let unsubscribeLayout: (() => void) | null = null;
let unsubscribeSettings: (() => void) | null = null;

export function initializeSidebarUpdater(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  log.info(() => 'Initializing sidebar updater');

  unsubscribeSessions = $sessions.subscribe(() => {
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
}
