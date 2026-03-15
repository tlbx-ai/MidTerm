/**
 * Sidebar Updater Module
 *
 * Manages intelligent sidebar updates with surgical DOM updates
 * for data-only changes. Uses nanostores subscriptions for reactive updates.
 */

import type { LayoutNode, Session } from '../../types';
import { $sessions, $activeSessionId, $layout, $currentSettings } from '../../stores';
import { createLogger } from '../logging';
import {
  applySessionFilterSettingChange,
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
  getSessionDisplayInfo,
  applyPinButtonState,
} from './sessionList';
import { unregisterHeatCanvas } from './heatIndicator';

const log = createLogger('sidebarUpdater');

// =============================================================================
// State Tracking
// =============================================================================

/** Previous session IDs for membership change detection */
let previousSessionIds = new Set<string>();

/** Previous session data for data change detection */
let previousSessions: Record<string, Session> = {};

/** Signature of current layout leaf order (for layout-driven sidebar grouping) */
let previousLayoutSignature = '';

/** Whether the updater has been initialized */
let initialized = false;

/** Previously active sidebar item so we can update active state surgically */
let previousActiveItem: HTMLElement | null = null;
let unsubscribeSessions: (() => void) | null = null;
let unsubscribeActiveSession: (() => void) | null = null;
let unsubscribeLayout: (() => void) | null = null;
let unsubscribeSettings: (() => void) | null = null;

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

    if (prev && session.agentControlled !== prev.agentControlled) {
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
      session.shellType !== prev.shellType ||
      session.bookmarkId !== prev.bookmarkId
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
  const item = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (!item) return;

  const displayInfo = getSessionDisplayInfo(session);
  const wasProcessAsTitle = item.dataset.processAsTitle === '1';
  const isProcessAsTitle = !!displayInfo.useProcessAsTitle;

  // Mode changed (renamed ↔ unnamed): force full re-render
  if (wasProcessAsTitle !== isProcessAsTitle) {
    unregisterHeatCanvas(sessionId);
    item.remove();
    renderSessionList();
    return;
  }

  const pinBtn = item.querySelector<HTMLButtonElement>('.session-pin');
  if (pinBtn) {
    applyPinButtonState(pinBtn, !!session.bookmarkId);
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
  previousActiveItem?.classList.remove('active');

  if (!activeId) return;

  const sessionList = document.getElementById('session-list');
  if (!sessionList) return;

  const activeItem = sessionList.querySelector<HTMLElement>(
    `.session-item[data-session-id="${activeId}"]`,
  );
  if (!activeItem) return;

  activeItem.classList.add('active');
  previousActiveItem = activeItem;
  activeItem.scrollIntoView({
    behavior: 'auto',
    block: 'nearest',
    inline: 'nearest',
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
          session.shellType !== prev.shellType ||
          session.bookmarkId !== prev.bookmarkId)
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

function collectLayoutLeafIds(node: LayoutNode | null, ids: string[]): void {
  if (!node) return;
  if (node.type === 'leaf') {
    ids.push(node.sessionId);
    return;
  }

  for (const child of node.children) {
    collectLayoutLeafIds(child, ids);
  }
}

function getLayoutSignature(root: LayoutNode | null): string {
  if (!root) {
    return 'none';
  }

  const ids: string[] = [];
  collectLayoutLeafIds(root, ids);
  return ids.join('|');
}

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
  previousLayoutSignature = getLayoutSignature($layout.get().root);
  previousActiveItem = document.querySelector<HTMLElement>('.session-item.active');

  // Subscribe to session changes
  unsubscribeSessions = $sessions.subscribe((sessions) => {
    const changeType = detectChangeType(sessions);
    if (changeType === 'none') return;

    applyUpdate(changeType, sessions);
    previousSessions = { ...sessions };
    previousSessionIds = new Set(Object.keys(sessions));
  });

  // Subscribe to active session changes for active class and title updates
  unsubscribeActiveSession = $activeSessionId.subscribe((activeId) => {
    updateActiveStates(activeId);
    updateMobileTitle();
  });

  // Layout changes affect both in-layout state and sidebar grouping/order.
  // Re-render whenever layout leaf membership/order changes.
  unsubscribeLayout = $layout.subscribe((layout) => {
    const nextSignature = getLayoutSignature(layout.root);
    if (nextSignature === previousLayoutSignature) return;
    previousLayoutSignature = nextSignature;

    renderSessionList();
    updateMobileTitle();
  });

  unsubscribeSettings = $currentSettings.subscribe(() => {
    applySessionFilterSettingChange();
  });

  log.info(() => 'Sidebar updater initialized');
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
  previousActiveItem = null;
  initialized = false;
}
