/**
 * Session List Module
 *
 * Handles rendering and updating the sidebar session list,
 * including empty state and mobile title updates.
 */

import type { Session, ProcessState } from '../../types';
import { t } from '../i18n';
import { pendingSessions, dom } from '../../state';
import {
  $settingsOpen,
  $activeSessionId,
  $sessionList,
  getSession,
  isChildSession,
} from '../../stores';
import { MOBILE_BREAKPOINT, icon } from '../../constants';
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
  const session = getSession(sessionId);
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

  let candidate = trimmed;
  const firstChar = candidate[0] ?? '';
  if (firstChar === '"' || firstChar === "'") {
    const quote = firstChar;
    const closingQuote = candidate.indexOf(quote, 1);
    if (closingQuote > 1) {
      candidate = candidate.slice(1, closingQuote);
    }
  }

  const basename = candidate.replace(/\\/g, '/').split('/').pop() ?? candidate;
  const token = basename.trim().split(/\s+/)[0] ?? basename.trim();
  return token.replace(/\.exe$/i, '').toLowerCase();
}

// =============================================================================
// Callback Types
// =============================================================================

/** Callbacks for session list interactions */
export interface SessionListCallbacks {
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string) => void;
  onToggleAgentControl: (sessionId: string) => void;
  onPinToHistory: (sessionId: string) => void;
  onInjectGuidance?: (sessionId: string) => void;
  onCloseSidebar: () => void;
}

let callbacks: SessionListCallbacks | null = null;
let mobileActionBackdrop: HTMLDivElement | null = null;
let mobileMenuListenersBound = false;
const SESSION_GROUP_STORAGE_KEYS = {
  human: 'midterm.sidebar.humanSessionsCollapsed',
  agent: 'midterm.sidebar.agentSessionsCollapsed',
} as const;

export type SessionControlMode = 'human' | 'agent';

export interface SessionGroup {
  key: SessionControlMode;
  label: string;
  sessions: Session[];
  collapsed: boolean;
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize session list module
 */
export function initializeSessionList(): void {
  addProcessStateListener(handleProcessStateChange);

  if (!mobileMenuListenersBound) {
    document.addEventListener('keydown', handleMobileMenuKeydown);
    window.addEventListener('resize', closeMobileActionMenu);
    window.addEventListener('orientationchange', closeMobileActionMenu);
    mobileMenuListenersBound = true;
  }
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
 * Close the mobile action menu via keyboard.
 */
function handleMobileMenuKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeMobileActionMenu();
  }
}

/**
 * Session action dropdowns are only used on mobile layouts.
 */
function isMobileSessionMenuEnabled(): boolean {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

/**
 * Render shared icon + label content for session action buttons.
 */
function setActionButtonContent(
  button: HTMLButtonElement,
  label: string,
  iconMarkupOrText: string,
  useTextIcon: boolean = false,
): void {
  const iconEl = document.createElement('span');
  iconEl.className = `session-action-icon${useTextIcon ? ' text-icon' : ''}`;

  if (useTextIcon) {
    iconEl.textContent = iconMarkupOrText;
  } else {
    iconEl.innerHTML = iconMarkupOrText;
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'session-action-label';
  labelEl.textContent = label;

  button.replaceChildren(iconEl, labelEl);
  button.title = label;
  button.setAttribute('aria-label', label);
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
    const session = getSession(sessionId);
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
  const label = t('session.pinToQuickLaunch');
  pinBtn.classList.toggle('pinned', isPinned);
  setActionButtonContent(pinBtn, label, isPinned ? '\u2605' : '\u2606', true);
  pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
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
    // Preserve badges, clear everything else
    const layoutBadge = titleRow.querySelector('.layout-badge');
    const roleBadge = titleRow.querySelector('.session-role-badge');
    titleRow.innerHTML = '';
    renderProcessTitle(titleRow, fgInfo, sessionId);
    if (roleBadge) titleRow.appendChild(roleBadge);
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
  document.querySelectorAll<HTMLElement>('.session-item.menu-open').forEach((el) => {
    el.classList.remove('menu-open');
    el.classList.remove('menu-open-up');

    const actions = el.querySelector<HTMLElement>('.session-actions');
    if (actions) {
      actions.style.removeProperty('left');
      actions.style.removeProperty('top');
      actions.style.removeProperty('max-height');
    }

    const menuBtn = el.querySelector<HTMLButtonElement>('.session-menu-btn');
    menuBtn?.setAttribute('aria-expanded', 'false');
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

/**
 * Position the mobile dropdown next to its trigger while keeping it on-screen.
 */
function positionMobileActionMenu(item: HTMLElement): void {
  if (!isMobileSessionMenuEnabled()) {
    return;
  }

  const actions = item.querySelector<HTMLElement>('.session-actions');
  const menuBtn = item.querySelector<HTMLElement>('.session-menu-btn');
  if (!actions || !menuBtn) {
    return;
  }

  const viewportPadding = 12;
  const gap = 8;
  const triggerRect = menuBtn.getBoundingClientRect();

  item.classList.remove('menu-open-up');
  actions.style.removeProperty('max-height');

  const initialRect = actions.getBoundingClientRect();
  const availableBelow = window.innerHeight - triggerRect.bottom - viewportPadding - gap;
  const availableAbove = triggerRect.top - viewportPadding - gap;
  const openUp =
    availableBelow < Math.min(initialRect.height, 220) && availableAbove > availableBelow;

  item.classList.toggle('menu-open-up', openUp);

  const heightBudget = Math.max(
    96,
    Math.min(openUp ? availableAbove : availableBelow, window.innerHeight - viewportPadding * 2),
  );
  actions.style.maxHeight = `${heightBudget}px`;

  const menuRect = actions.getBoundingClientRect();
  const menuHeight = Math.min(menuRect.height, heightBudget);
  const menuWidth = menuRect.width;

  let left = triggerRect.right - menuWidth;
  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - viewportPadding - menuWidth));

  let top = triggerRect.bottom + gap;
  if (openUp) {
    top = Math.max(viewportPadding, triggerRect.top - menuHeight - gap);
  } else {
    top = Math.min(top, window.innerHeight - viewportPadding - menuHeight);
  }

  actions.style.left = `${left}px`;
  actions.style.top = `${top}px`;
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

function isAgentControlled(session: Session | null | undefined): boolean {
  return session?.agentControlled === true;
}

function getSessionControlMode(session: Session): SessionControlMode {
  return isAgentControlled(session) ? 'agent' : 'human';
}

function isSessionGroupCollapsed(group: SessionControlMode): boolean {
  return localStorage.getItem(SESSION_GROUP_STORAGE_KEYS[group]) === 'true';
}

function toggleSessionGroup(section: HTMLElement, group: SessionControlMode): void {
  const collapsed = section.classList.toggle('collapsed');
  localStorage.setItem(SESSION_GROUP_STORAGE_KEYS[group], String(collapsed));
}

export function groupSessionsByController(sessions: Session[]): SessionGroup[] {
  const humanSessions = sessions.filter((session) => getSessionControlMode(session) === 'human');
  const agentSessions = sessions.filter((session) => getSessionControlMode(session) === 'agent');
  const groups: SessionGroup[] = [];

  if (humanSessions.length > 0) {
    groups.push({
      key: 'human',
      label: t('sidebar.humanControlled'),
      sessions: humanSessions,
      collapsed: isSessionGroupCollapsed('human'),
    });
  }

  if (agentSessions.length > 0) {
    groups.push({
      key: 'agent',
      label: t('sidebar.agentControlled'),
      sessions: agentSessions,
      collapsed: isSessionGroupCollapsed('agent'),
    });
  }

  return groups;
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
  const controlMode = getSessionControlMode(session);
  const item = document.createElement('div');
  item.className =
    'session-item' +
    (isActive ? ' active' : '') +
    (isPending ? ' pending' : '') +
    (inLayout ? ' in-layout' : '') +
    (isChild ? ' tmux-child' : '') +
    (controlMode === 'agent' ? ' agent-controlled' : '');
  item.dataset.sessionId = sessionId;
  item.dataset.controlMode = controlMode;
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

  const agentBadge = document.createElement('span');
  agentBadge.className = 'session-role-badge';
  agentBadge.textContent = 'AI';
  agentBadge.title = t('sidebar.agentControlled');

  if (displayInfo.useProcessAsTitle) {
    // Unnamed sessions: show cwd + process as the title row
    item.dataset.processAsTitle = '1';
    const fgInfo = getForegroundInfo(sessionId);
    renderProcessTitle(titleRow, fgInfo, sessionId);
    if (controlMode === 'agent') {
      titleRow.appendChild(agentBadge);
    }
    titleRow.appendChild(layoutBadge);
  } else {
    const title = document.createElement('span');
    title.className = 'session-title truncate';
    title.textContent = displayInfo.primary;
    titleRow.appendChild(title);
    if (controlMode === 'agent') {
      titleRow.appendChild(agentBadge);
    }
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
  actions.id = `session-actions-${sessionId}`;
  actions.setAttribute('role', 'menu');

  if (!isPending && sessionId) {
    const controlBtn = document.createElement('button');
    controlBtn.className = 'session-control';
    controlBtn.classList.toggle('active', controlMode === 'agent');
    setActionButtonContent(
      controlBtn,
      controlMode === 'agent' ? t('session.markHumanControlled') : t('session.markAgentControlled'),
      'AI',
      true,
    );
    controlBtn.setAttribute('role', 'menuitem');
    controlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      callbacks?.onToggleAgentControl(sessionId);
    });

    const pinBtn = document.createElement('button');
    pinBtn.className = 'session-pin';
    applyPinButtonState(pinBtn, !!session.bookmarkId);
    pinBtn.setAttribute('role', 'menuitem');
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onPinToHistory(sessionId);
      }
    });

    const renameBtn = document.createElement('button');
    renameBtn.className = 'session-rename';
    setActionButtonContent(renameBtn, t('session.rename'), icon('rename'));
    renameBtn.setAttribute('role', 'menuitem');
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks) {
        callbacks.onRename(sessionId);
      }
    });

    const injectBtn = document.createElement('button');
    injectBtn.className = 'session-inject';
    setActionButtonContent(injectBtn, t('session.injectGuidance'), icon('inject'));
    injectBtn.setAttribute('role', 'menuitem');
    injectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      if (callbacks?.onInjectGuidance) {
        callbacks.onInjectGuidance(sessionId);
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'session-close';
    setActionButtonContent(closeBtn, t('session.close'), icon('close'));
    closeBtn.setAttribute('role', 'menuitem');
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
    setActionButtonContent(undockBtn, t('session.removeFromLayout'), icon('undock'));
    undockBtn.setAttribute('role', 'menuitem');
    undockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMobileActionMenu();
      undockSession(sessionId);
    });

    actions.appendChild(controlBtn);
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
    menuBtn.setAttribute('aria-label', t('session.actions'));
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-controls', actions.id);
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isMobileSessionMenuEnabled()) {
        return;
      }

      const isOpen = item.classList.contains('menu-open');
      closeMobileActionMenu();
      if (!isOpen) {
        item.classList.add('menu-open');
        menuBtn.setAttribute('aria-expanded', 'true');
        showMobileBackdrop();
        requestAnimationFrame(() => {
          positionMobileActionMenu(item);
        });
      }
    });
    item.appendChild(menuBtn);
  }

  item.appendChild(actions);
  return item;
}

/**
 * Create a collapsible session group section.
 */
function createSessionGroupSection(group: SessionGroup): HTMLDivElement {
  const section = document.createElement('div');
  section.className = `session-group session-group-${group.key}`;
  if (group.collapsed) {
    section.classList.add('collapsed');
  }

  const toggle = document.createElement('button');
  toggle.className = 'session-group-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true');
  toggle.addEventListener('click', () => {
    toggleSessionGroup(section, group.key);
    toggle.setAttribute(
      'aria-expanded',
      section.classList.contains('collapsed') ? 'false' : 'true',
    );
  });

  const caret = document.createElement('span');
  caret.className = 'session-group-caret';
  caret.textContent = '▾';

  const label = document.createElement('span');
  label.className = 'session-group-label';
  label.textContent = group.label;

  const count = document.createElement('span');
  count.className = 'session-group-count';
  count.textContent = String(group.sessions.length);

  toggle.append(caret, label, count);
  section.appendChild(toggle);

  const items = document.createElement('div');
  items.className = 'session-group-items';
  group.sessions.forEach((session) => {
    items.appendChild(
      createSessionItem(
        session,
        session.id === $activeSessionId.get(),
        pendingSessions.has(session.id),
      ),
    );
  });

  section.appendChild(items);
  return section;
}

function applySidebarGroupingClasses(sessionList: HTMLElement): void {
  sessionList.querySelectorAll<HTMLElement>('.session-group-items').forEach((groupItems) => {
    const allItems = groupItems.querySelectorAll<HTMLElement>('.session-item');
    allItems.forEach((item) => {
      item.classList.remove('tmux-last-child');
      item.classList.remove(
        'layout-group-start',
        'layout-group-middle',
        'layout-group-end',
        'layout-group-single',
      );
    });

    allItems.forEach((item, idx) => {
      if (!item.classList.contains('tmux-child')) {
        return;
      }

      const nextItem = allItems[idx + 1];
      if (
        !nextItem ||
        !nextItem.classList.contains('tmux-child') ||
        nextItem.dataset.parentId !== item.dataset.parentId
      ) {
        item.classList.add('tmux-last-child');
      }
    });

    allItems.forEach((item, idx) => {
      if (!item.classList.contains('in-layout')) return;

      const prev = allItems[idx - 1];
      const next = allItems[idx + 1];
      const prevInLayout = !!prev?.classList.contains('in-layout');
      const nextInLayout = !!next?.classList.contains('in-layout');

      if (!prevInLayout && !nextInLayout) {
        item.classList.add('layout-group-single');
      } else if (!prevInLayout) {
        item.classList.add('layout-group-start');
      } else if (!nextInLayout) {
        item.classList.add('layout-group-end');
      } else {
        item.classList.add('layout-group-middle');
      }
    });
  });
}

/**
 * Render the session list in the sidebar.
 */
export function renderSessionList(): void {
  if (!dom.sessionList) return;

  const sessionList = dom.sessionList;
  const groups = groupSessionsByController(getSidebarDisplaySessions());

  closeMobileActionMenu();
  sessionList.querySelectorAll<HTMLElement>('.session-item').forEach((item) => {
    const sessionId = item.dataset.sessionId;
    if (sessionId) {
      unregisterHeatCanvas(sessionId);
    }
  });

  sessionList.replaceChildren();

  groups.forEach((group) => {
    sessionList.appendChild(createSessionGroupSection(group));
  });

  applySidebarGroupingClasses(sessionList);
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
