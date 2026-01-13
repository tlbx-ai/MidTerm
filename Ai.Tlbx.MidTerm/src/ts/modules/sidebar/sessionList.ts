/**
 * Session List Module
 *
 * Handles rendering and updating the sidebar session list,
 * including empty state and mobile title updates.
 */

import type { Session, ProcessState } from '../../types';
import {
  sessions,
  activeSessionId,
  settingsOpen,
  pendingSessions,
  dom,
  renamingSessionId,
} from '../../state';
import { icon } from '../../constants';
import {
  registerProcessStateCallback,
  getForegroundInfo,
  getRacingLogText,
  getFullRacingLog,
  isRacingLogVisible,
} from '../process';

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
let mobileActionBackdrop: HTMLDivElement | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize session list module
 */
export function initializeSessionList(): void {
  registerProcessStateCallback(handleProcessStateChange);
}

/**
 * Set callbacks for session list interactions
 */
export function setSessionListCallbacks(cbs: SessionListCallbacks): void {
  callbacks = cbs;
}

/**
 * Handle process state change and update the UI
 */
function handleProcessStateChange(sessionId: string, _state: ProcessState): void {
  updateSessionProcessInfo(sessionId);
}

/**
 * Update process info display for a specific session
 */
function updateSessionProcessInfo(sessionId: string): void {
  const processInfoEl = document.querySelector(
    `.session-process-info[data-session-id="${sessionId}"]`,
  ) as HTMLElement | null;

  if (!processInfoEl) return;

  // Clear existing content
  processInfoEl.innerHTML = '';

  // Foreground process indicator
  const fgInfo = getForegroundInfo(sessionId);
  if (fgInfo.name) {
    const fgIndicator = document.createElement('span');
    fgIndicator.className = 'session-foreground';
    const cmdDisplay = fgInfo.commandLine ?? fgInfo.name;
    const truncatedCmd = cmdDisplay.length > 30 ? cmdDisplay.slice(0, 30) + '\u2026' : cmdDisplay;
    const cwdDisplay = fgInfo.cwd ? ` \u2022 ${shortenPath(fgInfo.cwd)}` : '';
    fgIndicator.textContent = `\u25B6 ${truncatedCmd}${cwdDisplay}`;
    fgIndicator.title = `${fgInfo.commandLine ?? fgInfo.name}\n${fgInfo.cwd ?? ''}`;
    processInfoEl.appendChild(fgIndicator);
  }

  // Racing subprocess log (single line, full history on hover)
  const racingText = getRacingLogText(sessionId);
  if (racingText && isRacingLogVisible(sessionId)) {
    const racingLog = document.createElement('span');
    racingLog.className = 'session-racing-log';
    racingLog.textContent = `\u26A1 ${racingText}`;
    racingLog.title = getFullRacingLog(sessionId);
    processInfoEl.appendChild(racingLog);
  }
}

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Shorten a path for display (last 2 segments)
 */
function shortenPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) {
    return path;
  }
  return parts.slice(-2).join('/');
}

// =============================================================================
// Mobile Action Menu
// =============================================================================

/**
 * Close any open mobile action menus
 */
export function closeMobileActionMenu(): void {
  document.querySelectorAll('.session-item.menu-open').forEach((el) => {
    el.classList.remove('menu-open');
  });
  if (mobileActionBackdrop) {
    mobileActionBackdrop.remove();
    mobileActionBackdrop = null;
  }
}

/**
 * Show backdrop for mobile action menu
 */
function showMobileBackdrop(): void {
  if (mobileActionBackdrop) return;
  mobileActionBackdrop = document.createElement('div');
  mobileActionBackdrop.className = 'session-action-backdrop';
  mobileActionBackdrop.addEventListener('click', () => {
    closeMobileActionMenu();
  });
  document.body.appendChild(mobileActionBackdrop);
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

  // Preserve the item being renamed (if any) to avoid destroying the input mid-edit
  let renamingElement: HTMLElement | null = null;
  if (renamingSessionId) {
    renamingElement = dom.sessionList.querySelector(
      `[data-session-id="${renamingSessionId}"]`,
    ) as HTMLElement | null;
    if (renamingElement) {
      renamingElement.remove();
    }
  }

  dom.sessionList.innerHTML = '';

  sessions.forEach((session) => {
    // Reuse preserved element for the session being renamed
    if (session.id === renamingSessionId && renamingElement) {
      // Update active class in case it changed
      renamingElement.classList.toggle('active', session.id === activeSessionId);
      dom.sessionList!.appendChild(renamingElement);
      return;
    }
    const isPending = pendingSessions.has(session.id);
    const item = document.createElement('div');
    item.className =
      'session-item' +
      (session.id === activeSessionId ? ' active' : '') +
      (isPending ? ' pending' : '');
    item.dataset.sessionId = session.id;

    if (!isPending) {
      item.addEventListener('click', () => {
        closeMobileActionMenu();
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

    // Process indicator container
    const processInfo = document.createElement('div');
    processInfo.className = 'session-process-info';
    processInfo.dataset.sessionId = session.id;

    // Foreground process indicator
    const fgInfo = getForegroundInfo(session.id);
    if (fgInfo.name) {
      const fgIndicator = document.createElement('span');
      fgIndicator.className = 'session-foreground';
      const cmdDisplay = fgInfo.commandLine ?? fgInfo.name;
      const truncatedCmd = cmdDisplay.length > 30 ? cmdDisplay.slice(0, 30) + '\u2026' : cmdDisplay;
      const cwdDisplay = fgInfo.cwd ? ` \u2022 ${shortenPath(fgInfo.cwd)}` : '';
      fgIndicator.textContent = `\u25B6 ${truncatedCmd}${cwdDisplay}`;
      fgIndicator.title = `${fgInfo.commandLine ?? fgInfo.name}\n${fgInfo.cwd ?? ''}`;
      processInfo.appendChild(fgIndicator);
    }

    // Racing subprocess log (single line, full history on hover)
    const racingText = getRacingLogText(session.id);
    if (racingText && isRacingLogVisible(session.id)) {
      const racingLog = document.createElement('span');
      racingLog.className = 'session-racing-log';
      racingLog.textContent = `\u26A1 ${racingText}`;
      racingLog.title = getFullRacingLog(session.id);
      processInfo.appendChild(racingLog);
    }

    // Always add processInfo container so updateSessionProcessInfo can find it later
    info.appendChild(processInfo);

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    if (!isPending) {
      const resizeBtn = document.createElement('button');
      resizeBtn.className = 'session-resize';
      resizeBtn.innerHTML = icon('resize');
      resizeBtn.title = 'Fit to screen';
      resizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMobileActionMenu();
        if (callbacks) {
          callbacks.onResize(session.id);
        }
      });

      const renameBtn = document.createElement('button');
      renameBtn.className = 'session-rename';
      renameBtn.innerHTML = icon('rename');
      renameBtn.title = 'Rename session';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMobileActionMenu();
        if (callbacks) {
          callbacks.onRename(session.id);
        }
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'session-close';
      closeBtn.innerHTML = icon('close');
      closeBtn.title = 'Close session';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMobileActionMenu();
        if (callbacks) {
          callbacks.onDelete(session.id);
        }
      });

      actions.appendChild(resizeBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(closeBtn);
    }

    item.appendChild(info);

    // Mobile menu button (toggles action bar visibility)
    if (!isPending) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'session-menu-btn';
      menuBtn.innerHTML = icon('more');
      menuBtn.title = 'Actions';
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = item.classList.contains('menu-open');
        closeMobileActionMenu();
        if (!isOpen) {
          item.classList.add('menu-open');
          showMobileBackdrop();
        }
      });
      item.appendChild(menuBtn);
    }

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
    // Only show empty state if settings panel is not open
    if (!settingsOpen) {
      dom.emptyState.classList.remove('hidden');
      if (dom.settingsView) dom.settingsView.classList.add('hidden');
    }
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
