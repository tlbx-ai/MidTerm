/**
 * Session List Module
 *
 * Handles rendering and updating the sidebar session list,
 * including empty state and mobile title updates.
 */

import type { Session, ProcessState } from '../../types';
import { t } from '../i18n';
import { pendingSessions, dom } from '../../state';
import { $settingsOpen, $activeSessionId, $sessionList, isChildSession } from '../../stores';
import { icon } from '../../constants';
import { addProcessStateListener, getForegroundInfo } from '../process';
import {
  getLayoutSessionIds,
  isLayoutActive,
  isSessionInLayout,
  undockSession,
} from '../layout/layoutStore';
import { formatRuntimeDisplay } from './processDisplay';
import { registerHeatCanvas, unregisterHeatCanvas } from './heatIndicator';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a foreground process name is just the session's own shell.
 * Compares basename + extensionless identity of both values, handling
 * full paths, quoted command lines, and command arguments.
 */
function isShellProcess(processName: string, sessionId: string): boolean {
  const sessions = $sessionList.get();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session?.shellType) return false;
  const normalizedProcess = normalizeExecutableName(processName);
  const normalizedShell = normalizeExecutableName(session.shellType);
  return normalizedProcess !== '' && normalizedProcess === normalizedShell;
}

/**
 * Normalize a shell/process identifier to a comparable executable identity.
 * - strips command-line arguments
 * - strips quotes
 * - extracts basename from paths
 * - removes ".exe" extension
 */
function normalizeExecutableName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  let firstToken = trimmed;
  const firstChar = firstToken[0] ?? '';
  if (firstChar === '"' || firstChar === "'") {
    const quote = firstChar;
    const closingQuote = firstToken.indexOf(quote, 1);
    if (closingQuote > 1) {
      firstToken = firstToken.slice(1, closingQuote);
    }
  } else {
    const spaceIdx = firstToken.search(/\s/);
    if (spaceIdx > 0) {
      firstToken = firstToken.slice(0, spaceIdx);
    }
  }

  const basename = firstToken.replace(/\\/g, '/').split('/').pop() ?? firstToken;
  return basename.replace(/\\.exe$/i, '').toLowerCase();
}

// =============================================================================
// Callback Types
// =============================================================================

/** Callbacks for session list interactions */
export interface SessionListCallbacks {
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onPinToHistory: (sessionId: string) => void;
  onInjectGuidance?: (sessionId: string) => void;
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

  const cmdDisplay = formatRuntimeDisplay(processName, commandLine ?? null);
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
 * Render cwd + process as the title row content for unnamed sessions
 */
function renderProcessTitle(
  titleRow: HTMLElement,
  fgInfo: { cwd?: string | null; name?: string | null; commandLine?: string | null },
  sessionId: string,
): void {
  if (fgInfo.name && fgInfo.name !== 'shell' && !isShellProcess(fgInfo.name, sessionId)) {
    const fgIndicator = createForegroundIndicator(fgInfo.cwd, fgInfo.commandLine, fgInfo.name);
    fgIndicator.classList.add('process-title');
    titleRow.appendChild(fgIndicator);
  } else if (fgInfo.cwd) {
    const cwdSpan = document.createElement('span');
    cwdSpan.className = 'session-foreground process-title';
    const cwdInner = document.createElement('span');
    cwdInner.className = 'fg-cwd';
    cwdInner.textContent = fgInfo.cwd;
    cwdSpan.appendChild(cwdInner);
    cwdSpan.title = fgInfo.cwd;
    titleRow.appendChild(cwdSpan);
  } else {
    // Fallback: show shell type while process info is not yet available
    const sessions = $sessionList.get();
    const session = sessions.find((s) => s.id === sessionId);
    const fallback = session?.shellType || t('session.terminal');
    const title = document.createElement('span');
    title.className = 'session-title truncate';
    title.textContent = fallback;
    titleRow.appendChild(title);
  }
}

/**
 * Render pinned/unpinned state on a sidebar pin button.
 */
export function applyPinButtonState(pinBtn: HTMLButtonElement, isPinned: boolean): void {
  pinBtn.classList.toggle('pinned', isPinned);
  pinBtn.textContent = isPinned ? '\u2605' : '\u2606';
  pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
  pinBtn.title = t('session.pinToQuickLaunch');
}

/**
 * Update process info display for a specific session
 */
function updateSessionProcessInfo(sessionId: string): void {
  const sessionItem = document.querySelector<HTMLElement>(
    `.session-item[data-session-id="${sessionId}"]`,
  );
  if (!sessionItem) return;

  const fgInfo = getForegroundInfo(sessionId);

  // Unnamed sessions: update the title row directly
  if (sessionItem.dataset.processAsTitle === '1') {
    const titleRow = sessionItem.querySelector<HTMLElement>('.session-title-row');
    if (!titleRow) return;
    // Preserve layout badge, clear everything else
    const layoutBadge = titleRow.querySelector('.layout-badge');
    titleRow.innerHTML = '';
    renderProcessTitle(titleRow, fgInfo, sessionId);
    if (layoutBadge) titleRow.appendChild(layoutBadge);
    return;
  }

  // Named sessions: update the process info row
  const processInfoEl = sessionItem.querySelector('.session-process-info');
  if (!processInfoEl) return;

  processInfoEl.innerHTML = '';

  if (fgInfo.name && fgInfo.name !== 'shell' && !isShellProcess(fgInfo.name, sessionId)) {
    const fgIndicator = createForegroundIndicator(fgInfo.cwd, fgInfo.commandLine, fgInfo.name);
    processInfoEl.appendChild(fgIndicator);
  } else if (fgInfo.cwd) {
    const cwdSpan = document.createElement('span');
    cwdSpan.className = 'session-foreground';
    const cwdInner = document.createElement('span');
    cwdInner.className = 'fg-cwd';
    cwdInner.textContent = fgInfo.cwd;
    cwdSpan.appendChild(cwdInner);
    cwdSpan.title = fgInfo.cwd;
    processInfoEl.appendChild(cwdSpan);
  }
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
  useProcessAsTitle?: boolean;
}

/**
 * Get display info for a session (primary title and optional secondary subtitle)
 */
export function getSessionDisplayInfo(session: Session): SessionDisplayInfo {
  const termTitle = session.terminalTitle || session.shellType || t('session.terminal');
  if (session.name) {
    return { primary: session.name, secondary: termTitle };
  }
  // Process set a console title — show it as the primary title with process info below
  if (session.terminalTitle && !isShellProcess(session.terminalTitle, session.id)) {
    return { primary: session.terminalTitle, secondary: null };
  }
  // No name, no console title: show cwd + process as the title row
  return { primary: termTitle, secondary: null, useProcessAsTitle: true };
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
 * Get sidebar display order.
 * Keeps all sessions currently in the active layout contiguous and in layout-tree order.
 */
function getSidebarDisplaySessions(): Session[] {
  const sessions = $sessionList.get();
  if (sessions.length <= 1 || !isLayoutActive()) {
    return sessions;
  }

  const layoutIds = getLayoutSessionIds();
  if (layoutIds.length < 2) {
    return sessions;
  }

  const sessionsById = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  const layoutIdSet = new Set(layoutIds);

  const groupedLayoutSessions: Session[] = [];
  for (const id of layoutIds) {
    const session = sessionsById.get(id);
    if (session) {
      groupedLayoutSessions.push(session);
    }
  }

  if (groupedLayoutSessions.length < 2) {
    return sessions;
  }

  const firstLayoutIndex = sessions.findIndex((s) => layoutIdSet.has(s.id));
  if (firstLayoutIndex < 0) {
    return sessions;
  }

  const nonLayoutSessions = sessions.filter((s) => !layoutIdSet.has(s.id));
  const nonLayoutBeforeAnchorCount = sessions
    .slice(0, firstLayoutIndex)
    .filter((s) => !layoutIdSet.has(s.id)).length;

  return [
    ...nonLayoutSessions.slice(0, nonLayoutBeforeAnchorCount),
    ...groupedLayoutSessions,
    ...nonLayoutSessions.slice(nonLayoutBeforeAnchorCount),
  ];
}

/**
 * Create a session item DOM element
 */
function createSessionItem(
  session: Session,
  isActive: boolean,
  isPending: boolean,
): HTMLDivElement {
  const sessionId = session.id;
  const inLayout = isSessionInLayout(sessionId);
  const isChild = isChildSession(sessionId);
  const item = document.createElement('div');
  item.className =
    'session-item' +
    (isActive ? ' active' : '') +
    (isPending ? ' pending' : '') +
    (inLayout ? ' in-layout' : '') +
    (isChild ? ' tmux-child' : '');
  item.dataset.sessionId = sessionId;
  if (isChild) {
    item.dataset.parentId = session.parentSessionId ?? '';
  }
  item.draggable = !isPending && !isChild;

  if (!isPending) {
    item.addEventListener('click', () => {
      closeMobileActionMenu();
      if (callbacks && sessionId) {
        callbacks.onSelect(sessionId);
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

  const titleRow = document.createElement('div');
  titleRow.className = 'session-title-row';

  // Layout badge (shown when session is in layout)
  const layoutBadge = document.createElement('span');
  layoutBadge.className = 'layout-badge';
  layoutBadge.textContent = t('session.split');
  layoutBadge.title = t('session.splitTooltip');

  if (displayInfo.useProcessAsTitle) {
    // Unnamed sessions: show cwd + process as the title row
    item.dataset.processAsTitle = '1';
    const fgInfo = getForegroundInfo(sessionId);
    renderProcessTitle(titleRow, fgInfo, sessionId);
    titleRow.appendChild(layoutBadge);
  } else {
    const title = document.createElement('span');
    title.className = 'session-title truncate';
    title.textContent = displayInfo.primary;
    titleRow.appendChild(title);
    titleRow.appendChild(layoutBadge);

    if (displayInfo.secondary) {
      item.classList.add('two-line');
      const subtitle = document.createElement('span');
      subtitle.className = 'session-subtitle truncate';
      subtitle.textContent = displayInfo.secondary;
      titleRow.appendChild(subtitle);
    }
  }

  info.appendChild(titleRow);

  // Process indicator container (used for named sessions, empty for unnamed)
  const processInfo = document.createElement('div');
  processInfo.className = 'session-process-info';
  processInfo.dataset.sessionId = sessionId;

  if (!displayInfo.useProcessAsTitle) {
    const fgInfo = getForegroundInfo(sessionId);
    if (fgInfo.name && fgInfo.name !== 'shell' && !isShellProcess(fgInfo.name, sessionId)) {
      const fgIndicator = createForegroundIndicator(fgInfo.cwd, fgInfo.commandLine, fgInfo.name);
      processInfo.appendChild(fgIndicator);
    } else if (fgInfo.cwd) {
      const cwdSpan = document.createElement('span');
      cwdSpan.className = 'session-foreground';
      const cwdInner = document.createElement('span');
      cwdInner.className = 'fg-cwd';
      cwdInner.textContent = fgInfo.cwd;
      cwdSpan.appendChild(cwdInner);
      cwdSpan.title = fgInfo.cwd;
      processInfo.appendChild(cwdSpan);
    }
  }

  // Always add processInfo container so updateSessionProcessInfo can find it later
  info.appendChild(processInfo);

  const actions = document.createElement('div');
  actions.className = 'session-actions';

  if (!isPending && sessionId) {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'session-pin';
    applyPinButtonState(pinBtn, !!session.bookmarkId);
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onPinToHistory(sessionId);
      }
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-rename';
    renameBtn.innerHTML = icon('rename');
    renameBtn.title = t('session.rename');
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onRename(sessionId);
      }
    });

    const injectBtn = document.createElement('button');
    injectBtn.className = 'session-inject';
    injectBtn.innerHTML = icon('inject');
    injectBtn.title = t('session.injectGuidance');
    injectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks?.onInjectGuidance) {
        callbacks.onInjectGuidance(sessionId);
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'session-close';
    closeBtn.innerHTML = icon('close');
    closeBtn.title = t('session.close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onDelete(sessionId);
      }
    });

    // Undock button (only shown when in layout)
    const undockBtn = document.createElement('button');
    undockBtn.className = 'session-undock';
    undockBtn.innerHTML = icon('undock');
    undockBtn.title = t('session.removeFromLayout');
    undockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      undockSession(sessionId);
    });

    actions.appendChild(pinBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(injectBtn);
    actions.appendChild(undockBtn);
    actions.appendChild(closeBtn);
  }

  // Heat indicator canvas (left strip, shows byte activity as thermal color)
  const heatCanvas = document.createElement('canvas');
  heatCanvas.className = 'heat-canvas';
  registerHeatCanvas(sessionId, heatCanvas);
  item.prepend(heatCanvas);

  item.appendChild(info);

  // Mobile menu button (toggles action bar visibility)
  if (!isPending) {
    const menuBtn = document.createElement('button');
    menuBtn.className = 'session-menu-btn';
    menuBtn.innerHTML = icon('more');
    menuBtn.title = t('session.actions');
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
  const sessions = getSidebarDisplaySessions();
  const activeSessionId = $activeSessionId.get();

  // Build set of current session IDs
  const newIds = new Set(sessions.map((s) => s.id));

  // Remove items that no longer exist
  const existingItems = sessionList.querySelectorAll('.session-item');
  existingItems.forEach((item) => {
    const itemId = (item as HTMLElement).dataset.sessionId;
    if (itemId && !newIds.has(itemId)) {
      unregisterHeatCanvas(itemId);
      item.remove();
    }
  });

  // Add/update items in order
  let previousElement: Element | null = null;
  sessions.forEach((session) => {
    const id = session.id;
    const existingItem = sessionList.querySelector(`[data-session-id="${id}"]`);
    const isPending = pendingSessions.has(id);

    if (existingItem) {
      // Update active state, pending state, and layout state
      existingItem.classList.toggle('active', id === activeSessionId);
      existingItem.classList.toggle('pending', isPending);
      existingItem.classList.toggle('in-layout', isSessionInLayout(id));
      const isChild = isChildSession(id);
      existingItem.classList.toggle('tmux-child', isChild);
      const htmlItem = existingItem as HTMLElement;
      if (isChild) {
        htmlItem.dataset.parentId = session.parentSessionId ?? '';
      } else {
        delete htmlItem.dataset.parentId;
      }
      htmlItem.draggable = !isPending && !isChild;

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
      const item = createSessionItem(session, id === activeSessionId, isPending);
      if (previousElement) {
        previousElement.after(item);
      } else {
        sessionList.prepend(item);
      }
      previousElement = item;
    }
  });

  // Mark last child in each tmux group
  const allItems = sessionList.querySelectorAll('.session-item');
  allItems.forEach((item) => {
    (item as HTMLElement).classList.remove('tmux-last-child');
    (item as HTMLElement).classList.remove(
      'layout-group-start',
      'layout-group-middle',
      'layout-group-end',
      'layout-group-single',
    );
  });
  allItems.forEach((item, idx) => {
    if ((item as HTMLElement).classList.contains('tmux-child')) {
      const nextItem = allItems[idx + 1] as HTMLElement | undefined;
      if (
        !nextItem ||
        !nextItem.classList.contains('tmux-child') ||
        nextItem.dataset.parentId !== (item as HTMLElement).dataset.parentId
      ) {
        (item as HTMLElement).classList.add('tmux-last-child');
      }
    }
  });

  // Mark contiguous layout groups in sidebar order for explicit visual grouping
  allItems.forEach((item, idx) => {
    const current = item as HTMLElement;
    if (!current.classList.contains('in-layout')) return;

    const prev = allItems[idx - 1] as HTMLElement | undefined;
    const next = allItems[idx + 1] as HTMLElement | undefined;
    const prevInLayout = !!prev?.classList.contains('in-layout');
    const nextInLayout = !!next?.classList.contains('in-layout');

    if (!prevInLayout && !nextInLayout) {
      current.classList.add('layout-group-single');
    } else if (!prevInLayout) {
      current.classList.add('layout-group-start');
    } else if (!nextInLayout) {
      current.classList.add('layout-group-end');
    } else {
      current.classList.add('layout-group-middle');
    }
  });
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
