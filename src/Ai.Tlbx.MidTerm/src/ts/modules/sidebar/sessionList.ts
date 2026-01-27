/**
 * Session List Module
 *
 * Handles rendering and updating the sidebar session list,
 * including empty state and mobile title updates.
 */

import type { Session, ProcessState } from '../../types';
import { pendingSessions, dom } from '../../state';
import { $settingsOpen, $activeSessionId, $sessionList } from '../../stores';
import { icon } from '../../constants';
import { addProcessStateListener, getForegroundInfo } from '../process';
import { isSessionInLayout, undockSession } from '../layout/layoutStore';

// =============================================================================
// Callback Types
// =============================================================================

/** Callbacks for session list interactions */
export interface SessionListCallbacks {
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onResize: (sessionId: string) => void;
  onPinToHistory: (sessionId: string) => void;
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
  addProcessStateListener(handleProcessStateChange);
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
 * Create the foreground process indicator element
 * Layout: ...directory> process...
 * - Directory ellipsis from left (end of path is most important)
 * - Process ellipsis from right (process name is most important)
 */
function createForegroundIndicator(
  cwd: string | null | undefined,
  commandLine: string | null | undefined,
  processName: string,
): HTMLElement {
  const container = document.createElement('span');
  container.className = 'session-foreground';

  const cmdDisplay = stripExePath(commandLine ?? processName);
  container.title = `${commandLine ?? processName}\n${cwd ?? ''}`;

  if (cwd) {
    const cwdSpan = document.createElement('span');
    cwdSpan.className = 'fg-cwd';
    cwdSpan.textContent = cwd;
    container.appendChild(cwdSpan);

    const separator = document.createElement('span');
    separator.className = 'fg-separator';
    separator.textContent = '>';
    container.appendChild(separator);
  }

  const processSpan = document.createElement('span');
  processSpan.className = 'fg-process';
  processSpan.textContent = cmdDisplay;
  container.appendChild(processSpan);

  return container;
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
    const fgIndicator = createForegroundIndicator(fgInfo.cwd, fgInfo.commandLine, fgInfo.name);
    processInfoEl.appendChild(fgIndicator);
  }
}

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Strip executable path from command line, keeping just the exe name and arguments.
 * Also strips .exe extension on Windows for cleaner display.
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
      const exeName = (quotedPath.replace(/\\/g, '/').split('/').pop() || quotedPath).replace(
        /\.exe$/i,
        '',
      );
      return (exeName + rest).trim();
    }
  }

  // Handle unquoted path - split on first space
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    // No arguments, just strip the path from the executable
    return (trimmed.replace(/\\/g, '/').split('/').pop() || trimmed).replace(/\.exe$/i, '');
  }

  const exePart = trimmed.slice(0, spaceIdx);
  const argsPart = trimmed.slice(spaceIdx);
  const exeName = (exePart.replace(/\\/g, '/').split('/').pop() || exePart).replace(/\.exe$/i, '');
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
  const inLayout = isSessionInLayout(session.id);
  const item = document.createElement('div');
  item.className =
    'session-item' +
    (isActive ? ' active' : '') +
    (isPending ? ' pending' : '') +
    (inLayout ? ' in-layout' : '');
  item.dataset.sessionId = session.id;
  item.draggable = !isPending;

  if (!isPending) {
    item.addEventListener('click', (e) => {
      // Don't select if clicking on drag handle
      if ((e.target as HTMLElement).closest('.drag-handle')) return;
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onSelect(session.id);
        callbacks.onCloseSidebar();
      }
    });
  }

  // Drag handle
  const dragHandle = document.createElement('div');
  dragHandle.className = 'drag-handle';
  const dragDots = document.createElement('div');
  dragDots.className = 'drag-handle-dots';
  dragHandle.appendChild(dragDots);
  item.appendChild(dragHandle);

  const info = document.createElement('div');
  info.className = 'session-info';

  if (isPending) {
    const spinner = document.createElement('span');
    spinner.className = 'session-spinner';
    info.appendChild(spinner);
  }

  const displayInfo = getSessionDisplayInfo(session);

  const titleRow = document.createElement('div');
  titleRow.className = 'session-title-row';

  const title = document.createElement('span');
  title.className = 'session-title truncate';
  title.textContent = displayInfo.primary;
  titleRow.appendChild(title);

  // Layout badge (shown when session is in layout)
  const layoutBadge = document.createElement('span');
  layoutBadge.className = 'layout-badge';
  layoutBadge.textContent = 'SPLIT';
  layoutBadge.title = 'Session is in a split layout';
  titleRow.appendChild(layoutBadge);

  info.appendChild(titleRow);

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
    const fgIndicator = createForegroundIndicator(fgInfo.cwd, fgInfo.commandLine, fgInfo.name);
    processInfo.appendChild(fgIndicator);
  }

  // Always add processInfo container so updateSessionProcessInfo can find it later
  info.appendChild(processInfo);

  const actions = document.createElement('div');
  actions.className = 'session-actions';

  if (!isPending) {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'session-pin';
    pinBtn.textContent = '\u2606';
    pinBtn.title = 'Pin to QuickLaunch';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onPinToHistory(session.id);
      }
    });

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

    // Undock button (only shown when in layout)
    const undockBtn = document.createElement('button');
    undockBtn.className = 'session-undock';
    undockBtn.textContent = 'Undock';
    undockBtn.title = 'Remove from split layout';
    undockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      undockSession(session.id);
    });

    actions.appendChild(pinBtn);
    actions.appendChild(resizeBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(undockBtn);
    actions.appendChild(closeBtn);
  }

  item.appendChild(info);

  // Action hint indicator (desktop - subtle dots to indicate hover actions)
  if (!isPending) {
    const actionHint = document.createElement('span');
    actionHint.className = 'session-action-hint';
    actionHint.innerHTML = icon('more');
    item.appendChild(actionHint);
  }

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
 * Render the session list in the sidebar using diff-based updates.
 * Only adds/removes/reorders items as needed, avoiding full DOM rebuilds.
 */
export function renderSessionList(): void {
  if (!dom.sessionList) return;

  const sessionList = dom.sessionList;
  const sessions = $sessionList.get();
  const activeSessionId = $activeSessionId.get();

  // Build set of current session IDs
  const newIds = new Set(sessions.map((s) => s.id));

  // Remove items that no longer exist
  const existingItems = sessionList.querySelectorAll('.session-item');
  existingItems.forEach((item) => {
    const itemId = (item as HTMLElement).dataset.sessionId;
    if (itemId && !newIds.has(itemId)) {
      item.remove();
    }
  });

  // Add/update items in order
  let previousElement: Element | null = null;
  sessions.forEach((session) => {
    const existingItem = sessionList.querySelector(
      `[data-session-id="${session.id}"]`,
    ) as HTMLElement | null;
    const isPending = pendingSessions.has(session.id);

    if (existingItem) {
      // Update active state, pending state, and layout state
      existingItem.classList.toggle('active', session.id === activeSessionId);
      existingItem.classList.toggle('pending', isPending);
      existingItem.classList.toggle('in-layout', isSessionInLayout(session.id));

      // Ensure correct order
      if (previousElement) {
        if (existingItem.previousElementSibling !== previousElement) {
          previousElement.after(existingItem);
        }
      } else if (existingItem !== sessionList.firstElementChild) {
        sessionList.prepend(existingItem);
      }
      previousElement = existingItem;
    } else {
      // Create new item
      const item = createSessionItem(session, session.id === activeSessionId, isPending);
      if (previousElement) {
        previousElement.after(item);
      } else {
        sessionList.prepend(item);
      }
      previousElement = item;
    }
  });

  // Update count (only non-pending sessions)
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
