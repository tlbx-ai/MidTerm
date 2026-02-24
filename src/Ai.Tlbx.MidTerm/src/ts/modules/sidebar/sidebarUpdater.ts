/**
 * Sidebar Updater Module
 *
 * Manages intelligent sidebar updates with surgical DOM updates
 * for data-only changes. Uses nanostores subscriptions for reactive updates.
 */

import type { Session } from '../../types';
import { $sessions, $activeSessionId, $layout } from '../../stores';
import { createLogger } from '../logging';
import {
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
  getSessionDisplayInfo,
} from './sessionList';
import { isSessionInLayout } from '../layout/layoutStore';

const log = createLogger('sidebarUpdater');

// =============================================================================
// State Tracking
// =============================================================================

/** Previous session IDs for membership change detection */
let previousSessionIds = new Set<string>();

/** Previous session data for data change detection */
let previousSessions: Record<string, Session> = {};

/** Whether the updater has been initialized */
let initialized = false;

// =============================================================================
// Change Detection
// =============================================================================

type ChangeType = 'none' | 'membership' | 'data' | 'order';

/**
 * Detect what type of change occurred between previous and current sessions
 */
function detectChangeType(sessions: Record<string, Session>): ChangeType {
  const newIds = new Set(Object.keys(sessions));

  // Check for membership change (add/remove)
  if (newIds.size !== previousSessionIds.size) {
    return 'membership';
  }
  for (const id of newIds) {
    if (!previousSessionIds.has(id)) return 'membership';
  }

  // Check for order change
  for (const [id, session] of Object.entries(sessions)) {
    const prev = previousSessions[id];
    if (prev && session._order !== prev._order) {
      return 'order';
    }
  }

  // Check for parent change (triggers full re-render since ordering changes)
  for (const [id, session] of Object.entries(sessions)) {
    const prev = previousSessions[id];
    if (prev && session.parentSessionId !== prev.parentSessionId) {
      return 'membership';
    }
  }

  // Check for data change
  for (const [id, session] of Object.entries(sessions)) {
    const prev = previousSessions[id];
    if (!prev) continue;
    if (
      session.name !== prev.name ||
      session.terminalTitle !== prev.terminalTitle ||
      session.shellType !== prev.shellType
    ) {
      return 'data';
    }
  }

  return 'none';
}

// =============================================================================
// Surgical DOM Updates
// =============================================================================

/**
 * Update only the content of a session item without recreating it.
 * Preserves hover states, event listeners, and focus.
 */
function updateSessionItemContent(sessionId: string, session: Session): void {
  const item = document.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement | null;
  if (!item) return;

  const displayInfo = getSessionDisplayInfo(session);
  const wasProcessAsTitle = item.dataset.processAsTitle === '1';
  const isProcessAsTitle = !!displayInfo.useProcessAsTitle;

  // Mode changed (renamed ↔ unnamed): force full re-render
  if (wasProcessAsTitle !== isProcessAsTitle) {
    renderSessionList();
    return;
  }

  // Process-as-title mode: title row is managed by updateSessionProcessInfo
  if (isProcessAsTitle) return;

  // Named session: update title and subtitle text
  const titleEl = item.querySelector('.session-title');
  const subtitleEl = item.querySelector('.session-subtitle');

  if (titleEl && titleEl.textContent !== displayInfo.primary) {
    titleEl.textContent = displayInfo.primary;
  }

  if (displayInfo.secondary) {
    item.classList.add('two-line');
    if (subtitleEl) {
      if (subtitleEl.textContent !== displayInfo.secondary) {
        subtitleEl.textContent = displayInfo.secondary;
      }
    } else {
      const newSubtitle = document.createElement('span');
      newSubtitle.className = 'session-subtitle truncate';
      newSubtitle.textContent = displayInfo.secondary;
      const titleRow = item.querySelector('.session-title-row');
      if (titleRow) {
        titleRow.appendChild(newSubtitle);
      }
    }
  } else {
    item.classList.remove('two-line');
    subtitleEl?.remove();
  }
}

/**
 * Update active state on all session items without re-rendering
 */
function updateActiveStates(activeId: string | null): void {
  document.querySelectorAll('.session-item').forEach((item) => {
    const itemId = (item as HTMLElement).dataset.sessionId;
    item.classList.toggle('active', itemId === activeId);
  });
}

// =============================================================================
// Update Application
// =============================================================================

/**
 * Apply the appropriate update based on change type
 */
function applyUpdate(type: ChangeType, sessions: Record<string, Session>): void {
  if (type === 'membership') {
    log.info(() => 'Applying membership update (full re-render)');
    renderSessionList();
    updateEmptyState();
    updateMobileTitle();
  } else if (type === 'order') {
    log.verbose(() => 'Applying order update (full re-render)');
    renderSessionList();
  } else if (type === 'data') {
    log.verbose(() => 'Applying data update (surgical)');
    for (const [id, session] of Object.entries(sessions)) {
      const prev = previousSessions[id];
      if (
        prev &&
        (session.name !== prev.name ||
          session.terminalTitle !== prev.terminalTitle ||
          session.shellType !== prev.shellType)
      ) {
        updateSessionItemContent(id, session);
      }
    }
    updateMobileTitle();
  }
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize sidebar updater - subscribes to store changes
 */
export function initializeSidebarUpdater(): void {
  if (initialized) return;
  initialized = true;

  log.info(() => 'Initializing sidebar updater');

  // Initialize tracking state
  const initialSessions = $sessions.get();
  previousSessions = { ...initialSessions };
  previousSessionIds = new Set(Object.keys(initialSessions));

  // Subscribe to session changes
  $sessions.subscribe((sessions) => {
    const changeType = detectChangeType(sessions);
    if (changeType === 'none') return;

    applyUpdate(changeType, sessions);
    previousSessions = { ...sessions };
    previousSessionIds = new Set(Object.keys(sessions));
  });

  // Subscribe to active session changes for active class and title updates
  $activeSessionId.subscribe((activeId) => {
    updateActiveStates(activeId);
    updateMobileTitle();
  });

  // Subscribe to layout changes to update in-layout class on session items
  $layout.subscribe(() => {
    updateLayoutStates();
  });

  log.info(() => 'Sidebar updater initialized');
}

/**
 * Update in-layout class on all session items based on current layout state.
 */
function updateLayoutStates(): void {
  const sessionList = document.getElementById('session-list');
  if (!sessionList) return;

  const items = sessionList.querySelectorAll('.session-item');
  items.forEach((item) => {
    const sessionId = (item as HTMLElement).dataset.sessionId;
    if (sessionId) {
      item.classList.toggle('in-layout', isSessionInLayout(sessionId));
    }
  });
}
