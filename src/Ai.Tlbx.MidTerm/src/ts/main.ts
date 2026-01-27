/**
 * MidTerm Terminal Client
 *
 * Web-based terminal multiplexer frontend using xterm.js.
 * Main entry point - wires together all modules.
 */

import { initLoginPage } from './modules/login';
import { initTrustPage } from './modules/trust';
import { initThemeFromCookie } from './modules/theming';
import { createLogger, setLogLevel, setConsoleLogging, LogLevel } from './modules/logging';
import {
  connectStateWebSocket,
  connectMuxWebSocket,
  connectSettingsWebSocket,
  registerStateCallbacks,
  registerMuxCallbacks,
  registerSettingsCallbacks,
  sendInput,
  sendResize,
  requestBufferRefresh,
  sendActiveSessionHint,
} from './modules/comms';
import { initBadges } from './modules/badges';
import {
  createTerminalForSession,
  destroyTerminalForSession,
  preloadTerminalFont,
  initCalibrationTerminal,
  registerTerminalCallbacks,
  applyTerminalScaling,
  fitSessionToScreen,
  setupResizeObserver,
  setupVisualViewport,
  registerScalingCallbacks,
  bindSearchEvents,
  registerFileDropCallbacks,
  pasteToTerminal,
  scrollToBottom,
  focusActiveTerminal,
  calculateOptimalDimensions,
  setTerminalScrollback,
} from './modules/terminal';
import {
  updateEmptyState,
  updateMobileTitle,
  getSessionDisplayName,
  setSessionListCallbacks,
  toggleSidebar,
  closeSidebar,
  collapseSidebar,
  expandSidebar,
  restoreSidebarState,
  setupSidebarResize,
  initShareAccessButton,
  initNetworkSection,
  initVoiceSection,
  initializeSessionList,
  initializeSidebarUpdater,
  initSessionDrag,
  initTrafficIndicator,
} from './modules/sidebar';
import { initTabTitle } from './modules/tabTitle';
import { bindVoiceEvents, initVoiceControls } from './modules/voice';
import { initChatPanel } from './modules/chat';
import { toggleSettings, closeSettings, applyReceivedSettings } from './modules/settings';
import { bindAuthEvents } from './modules/auth';
import { fetchBootstrap } from './modules/bootstrap';
import {
  renderUpdatePanel,
  applyUpdate,
  checkForUpdates,
  showChangelog,
  closeChangelog,
  handleUpdateInfo,
  showUpdateLog,
} from './modules/updating';
import { initDiagnosticsPanel } from './modules/diagnostics';
import {
  initializeCommandHistory,
  initHistoryDropdown,
  toggleHistoryDropdown,
  createHistoryEntry,
  refreshHistory,
  type LaunchEntry,
} from './modules/history';
import { getForegroundInfo } from './modules/process';
import { initTouchController } from './modules/touchController';
import { initFileViewer } from './modules/fileViewer';
import {
  initLayoutRenderer,
  initDockOverlay,
  handleSessionClosed,
  isSessionInLayout,
  isLayoutActive,
  focusLayoutSession,
  registerLayoutCallbacks,
} from './modules/layout';
import {
  cacheDOMElements,
  sessionTerminals,
  dom,
  setFontsReadyPromise,
  newlyCreatedSessions,
  pendingSessions,
  bellNotificationsSuppressed,
  activeNotifications,
} from './state';
import {
  $stateWsConnected,
  $muxWsConnected,
  $activeSessionId,
  $sessionList,
  $renamingSessionId,
  $currentSettings,
  setSession,
  removeSession,
  getSession,
  setPendingRename,
  clearPendingRename,
} from './stores';
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from './constants';
import { bindClick } from './utils';

// Create logger for main module
const log = createLogger('main');

// Debug export for console access (typed in types/xterm-extensions.d.ts)
window.mmDebug = {
  get terminals() {
    return sessionTerminals;
  },
  get activeId() {
    return $activeSessionId.get();
  },
  get settings() {
    return $currentSettings.get();
  },
};

// =============================================================================
// Initialization
// =============================================================================

initThemeFromCookie();

document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  if (path === '/login' || path === '/login.html') {
    initLoginPage();
  } else if (path === '/trust' || path === '/trust.html') {
    initTrustPage();
  } else {
    init();
  }
});

async function init(): Promise<void> {
  // Initialize logging
  setLogLevel(LogLevel.Info);
  setConsoleLogging(true);
  log.info(() => 'MidTerm frontend initializing');

  cacheDOMElements();
  initTrafficIndicator();
  initBadges();
  initFileViewer();
  restoreSidebarState();
  setupSidebarResize();
  initializeSessionList();
  initializeSidebarUpdater();
  initTabTitle();
  initSessionDrag();
  initLayoutRenderer();
  initDockOverlay();
  initializeCommandHistory();
  initHistoryDropdown(spawnFromHistory);

  const fontPromise = preloadTerminalFont();
  setFontsReadyPromise(fontPromise);

  // Initialize calibration terminal after fonts are ready for accurate measurements
  fontPromise.then(() => initCalibrationTerminal());

  registerCallbacks();
  connectStateWebSocket();
  connectMuxWebSocket();
  connectSettingsWebSocket();

  bindEvents();
  bindAuthEvents();
  bindSearchEvents();
  initShareAccessButton();
  initNetworkSection();
  initVoiceSection();
  bindVoiceEvents();
  await initVoiceControls();
  initChatPanel();
  setupResizeObserver();
  setupVisualViewport();
  initTouchController();

  // Single bootstrap call replaces: fetchVersion, fetchNetworks, fetchSettings,
  // checkAuthStatus, checkUpdateResult, and checkSystemHealth
  fetchBootstrap();
  requestNotificationPermission();
  initDiagnosticsPanel();

  setupVisibilityChangeHandler();
  log.info(() => 'MidTerm frontend initialized');
}

// =============================================================================
// Callback Registration
// =============================================================================

function registerCallbacks(): void {
  registerStateCallbacks({
    destroyTerminalForSession,
    applyTerminalScaling,
    createTerminalForSession,
    updateEmptyState,
    selectSession,
    updateMobileTitle,
    renderUpdatePanel,
  });

  registerMuxCallbacks({
    applyTerminalScaling,
  });

  registerSettingsCallbacks({
    applyReceivedSettings,
    applyReceivedUpdate: handleUpdateInfo,
  });

  registerTerminalCallbacks({
    sendInput,
    showBellNotification,
    requestBufferRefresh,
  });

  registerFileDropCallbacks({
    sendInput,
    pasteToTerminal,
  });

  registerScalingCallbacks({
    sendResize: (sessionId: string, terminal: { cols: number; rows: number }) => {
      sendResize(sessionId, terminal.cols, terminal.rows);
    },
    focusActiveTerminal,
  });

  registerLayoutCallbacks({
    createTerminalForSession,
    sendActiveSessionHint,
  });

  setSessionListCallbacks({
    onSelect: selectSession,
    onDelete: deleteSession,
    onRename: startInlineRename,
    onResize: fitSessionToScreen,
    onPinToHistory: pinSessionToHistory,
    onCloseSidebar: closeSidebar,
  });
}

// =============================================================================
// Visibility Change Handler
// =============================================================================

function applyScrollbackProtection(): void {
  if ($currentSettings.get()?.scrollbackProtection !== true) return;

  const activeId = $activeSessionId.get();
  const state = activeId ? sessionTerminals.get(activeId) : null;
  if (!state?.terminal) return;

  const scrollPosBefore = state.terminal.buffer.active.viewportY;

  setTimeout(() => {
    const scrollPosAfter = state.terminal.buffer.active.viewportY;
    const delta = Math.abs(scrollPosAfter - scrollPosBefore);
    if (delta > 50) {
      state.terminal.scrollToLine(scrollPosBefore);
    }
  }, 50);
}

function setupVisibilityChangeHandler(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Reconnect WebSockets if they were dropped while in background
      // Buffer refresh is handled by muxChannel's reconnect handler if needed
      if (!$stateWsConnected.get()) {
        connectStateWebSocket();
      }
      if (!$muxWsConnected.get()) {
        connectMuxWebSocket();
      }

      // Refocus active terminal when page becomes visible
      focusActiveTerminal();

      // Claude Code scrollback glitch protection
      applyScrollbackProtection();
    }
  });

  // Also protect against focus from clicking into the browser window
  window.addEventListener('focus', () => {
    applyScrollbackProtection();
  });
}

// =============================================================================
// Session Management
// =============================================================================

async function createSession(): Promise<void> {
  const settings = $currentSettings.get();
  let cols = settings?.defaultCols ?? 120;
  let rows = settings?.defaultRows ?? 30;

  // Generate tempId early so we can use it for logging
  const tempId = 'pending-' + crypto.randomUUID();

  if (dom.terminalsArea) {
    const fontSize = settings?.fontSize ?? 14;
    const dims = await calculateOptimalDimensions(dom.terminalsArea, fontSize, tempId);
    if (dims && dims.cols > MIN_TERMINAL_COLS && dims.rows > MIN_TERMINAL_ROWS) {
      cols = dims.cols;
      rows = dims.rows;
    }
  }

  // Optimistic UI: add temporary session with spinner
  const tempSession = {
    id: tempId,
    name: null,
    terminalTitle: null,
    shellType: 'Loading...',
    cols: cols,
    rows: rows,
  };
  setSession(tempSession);
  pendingSessions.add(tempId);
  // Subscription handles renderSessionList via store change
  closeSidebar();

  fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Cols: cols, Rows: rows }),
  })
    .then((r) => r.json())
    .then((session) => {
      // Remove temporary session
      pendingSessions.delete(tempId);
      removeSession(tempId);

      newlyCreatedSessions.add(session.id);
      // Wait for session to appear in store (WebSocket update race condition)
      selectSessionWithRetry(session.id);
    })
    .catch((e) => {
      // Remove temporary session on error
      pendingSessions.delete(tempId);
      removeSession(tempId);
      // Subscription handles renderSessionList and updateEmptyState via store change
      log.error(() => `Failed to create session: ${e}`);
    });
}

/**
 * Select session with retry - handles race condition where WebSocket
 * state update hasn't arrived yet after API creates the session.
 */
function selectSessionWithRetry(sessionId: string, attempt = 0): void {
  const maxAttempts = 10;
  const retryDelay = 100;

  // Check if session exists in store
  if (getSession(sessionId)) {
    selectSession(sessionId);
    return;
  }

  // Retry if not found yet
  if (attempt < maxAttempts) {
    setTimeout(() => selectSessionWithRetry(sessionId, attempt + 1), retryDelay);
  } else {
    // Give up after max attempts - select anyway, terminal will work once WS update arrives
    log.warn(
      () => `Session ${sessionId} not in store after ${maxAttempts} attempts, selecting anyway`,
    );
    selectSession(sessionId);
  }
}

function selectSession(sessionId: string, options?: { closeSettingsPanel?: boolean }): void {
  // Only close settings if explicitly requested (e.g., user clicked a session)
  // Auto-selection from state updates should NOT close settings
  if (options?.closeSettingsPanel !== false) {
    closeSettings();
  }

  // If session is in layout, focus it there instead of switching to standalone
  if (isSessionInLayout(sessionId)) {
    focusLayoutSession(sessionId);
    sendActiveSessionHint(sessionId);
    // Ensure terminal exists
    const sessionInfo = getSession(sessionId);
    createTerminalForSession(sessionId, sessionInfo);
    return;
  }

  // Standalone mode - hide all terminals except selected
  sessionTerminals.forEach((state, id) => {
    // Don't hide terminals that are in the layout
    if (!isSessionInLayout(id)) {
      state.container.classList.add('hidden');
    }
    setTerminalScrollback(id, id === sessionId);
  });

  $activeSessionId.set(sessionId);
  sendActiveSessionHint(sessionId);

  const sessionInfo = getSession(sessionId);
  const state = createTerminalForSession(sessionId, sessionInfo);
  const isNewlyCreated = newlyCreatedSessions.has(sessionId);

  // Only show if not in layout (layout handles visibility)
  if (!isLayoutActive()) {
    state.container.classList.remove('hidden');
  }
  setTerminalScrollback(sessionId, true);

  requestAnimationFrame(() => {
    state.terminal.focus();
    scrollToBottom(sessionId);

    if (isNewlyCreated) {
      newlyCreatedSessions.delete(sessionId);
    }
  });

  // Subscription handles renderSessionList and updateMobileTitle via $activeSessionId change
  dom.emptyState?.classList.add('hidden');
}

function deleteSession(sessionId: string): void {
  // Remove from layout if present
  handleSessionClosed(sessionId);

  // Optimistic UI: remove session immediately for better UX
  destroyTerminalForSession(sessionId);

  // Remove from sessions store
  removeSession(sessionId);

  // If this was the active session, select another (but don't close settings panel)
  if ($activeSessionId.get() === sessionId) {
    $activeSessionId.set(null);
    const sessions = $sessionList.get();
    const firstSession = sessions[0];
    if (firstSession) {
      selectSession(firstSession.id, { closeSettingsPanel: false });
    }
  }

  // Subscription handles renderSessionList, updateEmptyState, updateMobileTitle via store change

  // Send delete request to server
  fetch('/api/sessions/' + sessionId, { method: 'DELETE' }).catch((e) => {
    log.error(() => `Failed to delete session ${sessionId}: ${e}`);
  });
}

function renameSession(sessionId: string, newName: string | null): void {
  const session = getSession(sessionId);
  if (!session) return;

  const trimmedName = (newName || '').trim();
  const nameToSend = trimmedName === '' || trimmedName === session.shellType ? null : trimmedName;

  // Store previous values for rollback
  const previousName = session.name;
  const wasManuallyNamed = session.manuallyNamed ?? false;

  // Mark as pending to protect from server overwrites until confirmed
  setPendingRename(sessionId, nameToSend);

  // Optimistic UI update via store
  setSession({ ...session, name: nameToSend, manuallyNamed: true });
  // Subscription handles renderSessionList and updateMobileTitle via store change

  fetch('/api/sessions/' + sessionId + '/name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameToSend }),
  }).catch((e) => {
    // Clear pending and rollback on error
    clearPendingRename(sessionId);
    const currentSession = getSession(sessionId);
    if (currentSession) {
      setSession({ ...currentSession, name: previousName, manuallyNamed: wasManuallyNamed });
    }
    // Subscription handles renderSessionList and updateMobileTitle via store change
    log.error(() => `Failed to rename session ${sessionId}: ${e}`);
  });
}

function startInlineRename(sessionId: string): void {
  const item = dom.sessionList?.querySelector(`[data-session-id="${sessionId}"]`);
  if (!item) return;

  const titleSpan = item.querySelector('.session-title');
  if (!titleSpan) return;

  const session = getSession(sessionId);
  const currentName = session ? session.name || session.shellType : '';

  // Mark this session as being renamed (prevents re-render from destroying input)
  $renamingSessionId.set(sessionId);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = currentName;

  // Prevent clicks inside input from bubbling to session item (which would select it)
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());

  let committed = false;
  function finishRename(): void {
    if (committed) return;
    committed = true;
    const newName = input.value;
    input.replaceWith(titleSpan as Node);
    $renamingSessionId.set(null);
    renameSession(sessionId, newName);
  }

  function cancelRename(): void {
    if (committed) return;
    committed = true;
    $renamingSessionId.set(null);
    input.replaceWith(titleSpan as Node);
  }

  input.addEventListener('blur', finishRename);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  });

  titleSpan.replaceWith(input);
  input.focus();
  input.select();
}

function promptRenameSession(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) return;

  const currentName = session.name || session.shellType;
  const newName = prompt('Rename terminal:', currentName);

  if (newName !== null) {
    renameSession(sessionId, newName);
  }
}

async function pinSessionToHistory(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    log.warn(() => `pinSessionToHistory: session ${sessionId} not found`);
    return;
  }

  const fgInfo = getForegroundInfo(sessionId);
  if (!fgInfo.name) {
    log.info(() => `pinSessionToHistory: no foreground process for ${sessionId}`);
    return;
  }

  const id = await createHistoryEntry({
    shellType: session.shellType,
    executable: fgInfo.name,
    commandLine: fgInfo.commandLine,
    workingDirectory: fgInfo.cwd ?? '',
    isStarred: true,
  });

  if (id) {
    refreshHistory();
    log.info(() => `Pinned to history: ${fgInfo.name} (id=${id})`);
  }
}

async function spawnFromHistory(entry: LaunchEntry): Promise<void> {
  const settings = $currentSettings.get();
  let cols = settings?.defaultCols ?? 120;
  let rows = settings?.defaultRows ?? 30;

  if (dom.terminalsArea) {
    const fontSize = settings?.fontSize ?? 14;
    const logId = 'history-' + crypto.randomUUID().slice(0, 8);
    const dims = await calculateOptimalDimensions(dom.terminalsArea, fontSize, logId);
    if (dims && dims.cols > MIN_TERMINAL_COLS && dims.rows > MIN_TERMINAL_ROWS) {
      cols = dims.cols;
      rows = dims.rows;
    }
  }

  closeSidebar();

  fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Cols: cols,
      Rows: rows,
      ShellType: entry.shellType,
      WorkingDirectory: entry.workingDirectory,
    }),
  })
    .then((r) => r.json())
    .then((session) => {
      newlyCreatedSessions.add(session.id);
      selectSession(session.id);

      if (entry.commandLine) {
        setTimeout(() => {
          sendInput(session.id, entry.commandLine!);
        }, 100);
      }
    })
    .catch((e) => {
      log.error(() => `Failed to spawn from history: ${e}`);
    });
}

// =============================================================================
// Notifications
// =============================================================================

function requestNotificationPermission(): void {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function showBellNotification(sessionId: string): void {
  const settings = $currentSettings.get();
  if (!settings) return;
  if (bellNotificationsSuppressed) return;

  const bellStyle = settings.bellStyle || 'notification';
  const session = getSession(sessionId);
  const title = session ? getSessionDisplayName(session) : 'Terminal';

  if (
    (bellStyle === 'notification' || bellStyle === 'both') &&
    Notification.permission === 'granted' &&
    document.hidden
  ) {
    // Close existing notification for this session (deduplication)
    const existing = activeNotifications.get(sessionId);
    if (existing) {
      existing.close();
    }

    const notification = new Notification(title, {
      body: 'Needs your attention',
      icon: '/favicon.ico',
      tag: `midterm-bell-${sessionId}`,
    });

    activeNotifications.set(sessionId, notification);

    notification.onclick = () => {
      window.focus();
      notification.close();
      activeNotifications.delete(sessionId);
    };

    // Auto-close after 15 seconds
    setTimeout(() => {
      notification.close();
      activeNotifications.delete(sessionId);
    }, 15000);
  }

  if (bellStyle === 'visual' || bellStyle === 'both') {
    const state = sessionTerminals.get(sessionId);
    if (state) {
      state.container.classList.add('bell-flash');
      setTimeout(() => {
        state.container.classList.remove('bell-flash');
      }, 200);
    }
  }
}

// =============================================================================
// Event Binding
// =============================================================================

function bindEvents(): void {
  bindClick('btn-new-session', createSession);
  bindClick('btn-new-session-mobile', createSession);
  bindClick('btn-create-terminal', createSession);

  bindClick('btn-hamburger', toggleSidebar);
  bindClick('btn-collapse-sidebar', collapseSidebar);
  bindClick('btn-expand-sidebar', expandSidebar);

  if (dom.sidebarOverlay) {
    dom.sidebarOverlay.addEventListener('click', closeSidebar);
  }

  bindClick('btn-ctrlc-mobile', () => {
    const activeId = $activeSessionId.get();
    if (activeId) sendInput(activeId, '\x03');
  });
  bindClick('btn-resize-mobile', () => {
    const activeId = $activeSessionId.get();
    if (activeId) fitSessionToScreen(activeId);
  });
  bindClick('btn-resize-titlebar', () => {
    const activeId = $activeSessionId.get();
    if (activeId) fitSessionToScreen(activeId);
  });
  bindClick('btn-rename-mobile', () => {
    const activeId = $activeSessionId.get();
    if (activeId) promptRenameSession(activeId);
  });
  bindClick('btn-rename-titlebar', () => {
    const activeId = $activeSessionId.get();
    if (activeId) promptRenameSession(activeId);
  });
  bindClick('btn-close-mobile', () => {
    const activeId = $activeSessionId.get();
    if (activeId) deleteSession(activeId);
  });

  if (dom.settingsBtn) {
    dom.settingsBtn.addEventListener('click', toggleSettings);
  }

  bindClick('update-btn', applyUpdate);
  bindClick('btn-check-updates', checkForUpdates);
  bindClick('btn-apply-update', applyUpdate);
  bindClick('btn-show-changelog', showChangelog);
  bindClick('btn-view-update-log', showUpdateLog);
  bindClick('btn-close-changelog', closeChangelog);
  bindClick('update-changelog-link', showChangelog);

  const changelogBackdrop = document.querySelector('#changelog-modal .modal-backdrop');
  if (changelogBackdrop) {
    changelogBackdrop.addEventListener('click', closeChangelog);
  }

  bindClick('btn-history', toggleHistoryDropdown);

  // Global keyboard shortcut: Alt+T to create new terminal
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createSession();
    }
  });

  import('./modules/settings').then((mod) => {
    mod.bindSettingsAutoSave();
  });
}
