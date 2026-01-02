/**
 * Session List Module
 *
 * Handles rendering and updating the sidebar session list,
 * including empty state and mobile title updates.
 */

import type { Session } from '../../types';
import {
  sessions,
  activeSessionId,
  settingsOpen,
  pendingSessions,
  dom
} from '../../state';

// =============================================================================
// Callback Types
// =============================================================================

/** Callbacks for session list interactions */
export interface SessionListCallbacks {
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onResize: (sessionId: string) => void;
  onCloseSidebar: () => void;
}

let callbacks: SessionListCallbacks | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Set callbacks for session list interactions
 */
export function setSessionListCallbacks(cbs: SessionListCallbacks): void {
  callbacks = cbs;
}

// =============================================================================
// Session Display
// =============================================================================

/**
 * Get the display name for a session
 */
export function getSessionDisplayName(session: Session): string {
  return session.name || session.shellType;
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Render the session list in the sidebar
 */
export function renderSessionList(): void {
  if (!dom.sessionList) return;

  dom.sessionList.innerHTML = '';

  sessions.forEach((session) => {
    const isPending = pendingSessions.has(session.id);
    const item = document.createElement('div');
    item.className = 'session-item' +
      (session.id === activeSessionId ? ' active' : '') +
      (isPending ? ' pending' : '');
    item.dataset.sessionId = session.id;

    if (!isPending) {
      item.addEventListener('click', () => {
        if (callbacks) {
          callbacks.onSelect(session.id);
          callbacks.onCloseSidebar();
        }
      });
    }

    const info = document.createElement('div');
    info.className = 'session-info';

    if (isPending) {
      const spinner = document.createElement('span');
      spinner.className = 'session-spinner';
      info.appendChild(spinner);
    }

    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = getSessionDisplayName(session);

    info.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    if (!isPending) {
      const resizeBtn = document.createElement('button');
      resizeBtn.className = 'session-resize';
      resizeBtn.innerHTML = '⤢';
      resizeBtn.title = 'Fit to screen';
      resizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (callbacks) {
          callbacks.onResize(session.id);
        }
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'session-rename';
      renameBtn.innerHTML = '✏️';
      renameBtn.title = 'Rename session';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (callbacks) {
          callbacks.onRename(session.id);
        }
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'session-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.title = 'Close session';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (callbacks) {
          callbacks.onDelete(session.id);
        }
      });

      actions.appendChild(resizeBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(closeBtn);
    }

    item.appendChild(info);
    item.appendChild(actions);
    dom.sessionList.appendChild(item);
  });

  // Count only non-pending sessions
  const realSessionCount = sessions.filter((s) => !pendingSessions.has(s.id)).length;
  if (dom.sessionCount) {
    dom.sessionCount.textContent = String(realSessionCount);
  }
}

/**
 * Update the empty state visibility based on session count
 */
export function updateEmptyState(): void {
  if (!dom.emptyState) return;

  if (sessions.length === 0) {
    dom.emptyState.classList.remove('hidden');
    if (dom.settingsView) dom.settingsView.classList.add('hidden');
  } else if (!settingsOpen) {
    dom.emptyState.classList.add('hidden');
  }
}

/**
 * Update the mobile title bar with current session name.
 * Also updates the desktop island title.
 */
export function updateMobileTitle(): void {
  if (!dom.mobileTitle) return;

  const session = sessions.find((s) => s.id === activeSessionId);
  dom.mobileTitle.textContent = session ? getSessionDisplayName(session) : 'MiddleManager';

  if (dom.topbarActions) {
    if (session) {
      dom.topbarActions.classList.remove('no-terminal');
    } else {
      dom.topbarActions.classList.add('no-terminal');
    }
  }

  // Also update the desktop island title
  if (dom.islandTitle) {
    dom.islandTitle.textContent = session ? getSessionDisplayName(session) : 'MiddleManager';
  }
}
