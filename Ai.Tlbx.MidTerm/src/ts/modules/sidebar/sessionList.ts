/**
 * Session List Module
 *
 * Handles rendering and updating the sidebar session list,
 * including empty state and mobile title updates.
 */

import type { Session, ProcessState } from '../../types';
import { pendingSessions, dom, setSessionListRerendering } from '../../state';
import { $settingsOpen, $activeSessionId, $sessionList, $renamingSessionId } from '../../stores';
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
  onSnapshot: (sessionId: string) => void;
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
    fgIndicator.className = 'session-foreground truncate';
    const cmdDisplay = stripExePath(fgInfo.commandLine ?? fgInfo.name);
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
    racingLog.className = 'session-racing-log truncate';
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

/**
 * Strip executable path from command line, keeping just the exe name and arguments.
 * Handles quoted paths (e.g., "C:\Program Files\git\bin\git.exe" status)
 * and unquoted paths (e.g., C:\Windows\System32\cmd.exe /c dir)
 */
function stripExePath(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return trimmed;

  // Handle quoted executable path
  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    if (endQuote > 1) {
      const quotedPath = trimmed.slice(1, endQuote);
      const rest = trimmed.slice(endQuote + 1);
      const exeName = quotedPath.replace(/\\/g, '/').split('/').pop() || quotedPath;
      return (exeName + rest).trim();
    }
  }

  // Handle unquoted path - split on first space
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    // No arguments, just strip the path from the executable
    return trimmed.replace(/\\/g, '/').split('/').pop() || trimmed;
  }

  const exePart = trimmed.slice(0, spaceIdx);
  const argsPart = trimmed.slice(spaceIdx);
  const exeName = exePart.replace(/\\/g, '/').split('/').pop() || exePart;
  return (exeName + argsPart).trim();
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
 * Create a session item DOM element
 */
function createSessionItem(
  session: Session,
  isActive: boolean,
  isPending: boolean,
): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'session-item' + (isActive ? ' active' : '') + (isPending ? ' pending' : '');
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
  title.className = 'session-title truncate';
  title.textContent = displayInfo.primary;
  info.appendChild(title);

  if (displayInfo.secondary) {
    item.classList.add('two-line');
    const subtitle = document.createElement('span');
    subtitle.className = 'session-subtitle truncate';
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
    fgIndicator.className = 'session-foreground truncate';
    const cmdDisplay = stripExePath(fgInfo.commandLine ?? fgInfo.name);
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
    racingLog.className = 'session-racing-log truncate';
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

    const snapshotBtn = document.createElement('button');
    snapshotBtn.className = 'session-snapshot';
    snapshotBtn.innerHTML = icon('save');
    snapshotBtn.title = 'Snapshot to history (debug)';
    snapshotBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onSnapshot(session.id);
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
    actions.appendChild(snapshotBtn);
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
  return item;
}

/**
 * Render the session list in the sidebar
 */
export function renderSessionList(): void {
  if (!dom.sessionList) return;

  const sessionList = dom.sessionList;

  // Set flag to prevent blur handler from committing rename during DOM manipulation
  setSessionListRerendering(true);

  try {
    const sessions = $sessionList.get();
    const activeSessionId = $activeSessionId.get();
    const renamingId = $renamingSessionId.get();

    // Find element being renamed (if any) - we'll keep it attached to prevent focus loss
    let renamingElement: HTMLElement | null = null;
    if (renamingId) {
      renamingElement = sessionList.querySelector(
        `[data-session-id="${renamingId}"]`,
      ) as HTMLElement | null;
    }

    // Remove all children EXCEPT the renaming element (to prevent blur)
    const children = Array.from(sessionList.children);
    for (const child of children) {
      if (child !== renamingElement) {
        child.remove();
      }
    }

    sessions.forEach((session) => {
      // Reuse preserved element for the session being renamed
      if (session.id === renamingId && renamingElement) {
        // Update active class in case it changed
        renamingElement.classList.toggle('active', session.id === activeSessionId);
        sessionList.appendChild(renamingElement);
        return;
      }

      const isPending = pendingSessions.has(session.id);
      const item = createSessionItem(session, session.id === activeSessionId, isPending);
      sessionList.appendChild(item);
    });

    // Count only non-pending sessions
    const realSessionCount = sessions.filter((s) => !pendingSessions.has(s.id)).length;
    if (dom.sessionCount) {
      dom.sessionCount.textContent = String(realSessionCount);
    }
  } finally {
    setSessionListRerendering(false);
  }
}

/**
 * Update the empty state visibility based on session count
 */
export function updateEmptyState(): void {
  if (!dom.emptyState) return;

  const isSettingsOpen = $settingsOpen.get();
  const sessions = $sessionList.get();
  if (sessions.length === 0) {
    // Only show empty state if settings panel is not open
    if (!isSettingsOpen) {
      dom.emptyState.classList.remove('hidden');
      if (dom.settingsView) dom.settingsView.classList.add('hidden');
    }
  } else if (!isSettingsOpen) {
    dom.emptyState.classList.add('hidden');
  }
}

/**
 * Update the mobile title bar with current session name.
 * Also updates the desktop collapsed title bar.
 */
export function updateMobileTitle(): void {
  if (!dom.mobileTitle) return;

  const sessions = $sessionList.get();
  const activeSessionId = $activeSessionId.get();
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
