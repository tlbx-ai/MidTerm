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

interface SessionDisplayInfo {
  primary: string;
  secondary: string | null;
}

/**
 * Get display info for a session (primary title and optional secondary subtitle)
 */
export function getSessionDisplayInfo(session: Session): SessionDisplayInfo {
  const termTitle = session.terminalTitle || session.shellType;
  if (session.name) {
    return { primary: session.name, secondary: termTitle };
  }
  return { primary: termTitle, secondary: null };
}

/**
 * Get the display name for a session (primary title only, for mobile/island)
 */
export function getSessionDisplayName(session: Session): string {
  const info = getSessionDisplayInfo(session);
  return info.primary;
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

    const displayInfo = getSessionDisplayInfo(session);

    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = displayInfo.primary;
    info.appendChild(title);

    if (displayInfo.secondary) {
      item.classList.add('two-line');
      const subtitle = document.createElement('span');
      subtitle.className = 'session-subtitle';
      subtitle.textContent = displayInfo.secondary;
      info.appendChild(subtitle);
    }

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
    dom.sessionList!.appendChild(item);
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
 * Also updates the desktop collapsed title bar.
 */
export function updateMobileTitle(): void {
  if (!dom.mobileTitle) return;

  const session = sessions.find((s) => s.id === activeSessionId);
  dom.mobileTitle.textContent = session ? getSessionDisplayName(session) : 'MidTerm';

  if (dom.topbarActions) {
    if (session) {
      dom.topbarActions.classList.remove('no-terminal');
    } else {
      dom.topbarActions.classList.add('no-terminal');
    }
  }

  // Also update the desktop collapsed title bar
  updateTitleBar(session);
}

/**
 * Update the collapsed title bar with current session info
 */
function updateTitleBar(session: Session | undefined): void {
  if (!dom.titleBarCustom || !dom.titleBarTerminal || !dom.titleBarSeparator) return;

  if (!session) {
    dom.titleBarCustom.textContent = 'MidTerm';
    dom.titleBarTerminal.textContent = '';
    dom.titleBarSeparator.style.display = 'none';
    return;
  }

  const info = getSessionDisplayInfo(session);

  if (session.name) {
    dom.titleBarCustom.textContent = info.primary;
    dom.titleBarTerminal.textContent = info.secondary || '';
    dom.titleBarSeparator.style.display = info.secondary ? '' : 'none';
  } else {
    dom.titleBarCustom.textContent = info.primary;
    dom.titleBarTerminal.textContent = '';
    dom.titleBarSeparator.style.display = 'none';
  }
}
