/**
 * MidTerm Terminal Client
 *
 * Web-based terminal multiplexer frontend using xterm.js.
 * Main entry point - wires together all modules.
 */

import { initLoginPage } from './modules/login';
import { initTrustPage } from './modules/trust';
import { initThemeFromCookie } from './modules/theming';
import {
  initLogStorage,
  createLogger,
  setLogLevel,
  setConsoleLogging,
  LogLevel,
} from './modules/logging';
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
import { bindVoiceEvents } from './modules/voice';
import { initChatPanel, restoreChatPanelState } from './modules/chat';
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
} from './modules/updating';
import { initDiagnosticsPanel } from './modules/diagnostics';
import {
  initializeCommandHistory,
  initHistoryDropdown,
  toggleHistoryDropdown,
  type LaunchEntry,
} from './modules/history';
import { initTouchController } from './modules/touchController';
import {
  cacheDOMElements,
  sessionTerminals,
  currentSettings,
  dom,
  setFontsReadyPromise,
  newlyCreatedSessions,
  pendingSessions,
} from './state';
import {
  $stateWsConnected,
  $muxWsConnected,
  $activeSessionId,
  $sessionList,
  $renamingSessionId,
  setSession,
  removeSession,
  getSession,
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
    return currentSettings;
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
  // Initialize logging first
  await initLogStorage();
  setLogLevel(LogLevel.Info);
  setConsoleLogging(true);
  log.info(() => 'MidTerm frontend initializing');

  cacheDOMElements();
  initTrafficIndicator();
  initBadges();
  restoreSidebarState();
  setupSidebarResize();
  initializeSessionList();
  initializeSidebarUpdater();
  initSessionDrag();
  initializeCommandHistory();
  initHistoryDropdown(spawnFromHistory);

  const fontPromise = preloadTerminalFont();
  setFontsReadyPromise(fontPromise);

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
  initChatPanel();
  restoreChatPanelState();
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

  setSessionListCallbacks({
    onSelect: selectSession,
    onDelete: deleteSession,
    onRename: startInlineRename,
    onResize: fitSessionToScreen,
    onCloseSidebar: closeSidebar,
  });
}

// =============================================================================
// Visibility Change Handler
// =============================================================================

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
    }
  });
}

// =============================================================================
// Session Management
// =============================================================================

async function createSession(): Promise<void> {
  let cols = currentSettings?.defaultCols ?? 120;
  let rows = currentSettings?.defaultRows ?? 30;

  // Generate tempId early so we can use it for logging
  const tempId = 'pending-' + crypto.randomUUID();

  if (dom.terminalsArea) {
    const fontSize = currentSettings?.fontSize ?? 14;
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

  sessionTerminals.forEach((state) => {
    state.container.classList.add('hidden');
  });

  $activeSessionId.set(sessionId);
  sendActiveSessionHint(sessionId);

  const sessionInfo = getSession(sessionId);
  const state = createTerminalForSession(sessionId, sessionInfo);
  const isNewlyCreated = newlyCreatedSessions.has(sessionId);
  state.container.classList.remove('hidden');

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

  // Optimistic UI update via store
  setSession({ ...session, name: nameToSend, manuallyNamed: true });
  // Subscription handles renderSessionList and updateMobileTitle via store change

  fetch('/api/sessions/' + sessionId + '/name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameToSend }),
  }).catch((e) => {
    // Rollback on error via store
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

async function spawnFromHistory(entry: LaunchEntry): Promise<void> {
  let cols = currentSettings?.defaultCols ?? 120;
  let rows = currentSettings?.defaultRows ?? 30;

  if (dom.terminalsArea) {
    const fontSize = currentSettings?.fontSize ?? 14;
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
  if (!currentSettings) return;

  const bellStyle = currentSettings.bellStyle || 'notification';
  const session = getSession(sessionId);
  const title = session ? getSessionDisplayName(session) : 'Terminal';

  if (
    (bellStyle === 'notification' || bellStyle === 'both') &&
    Notification.permission === 'granted' &&
    document.hidden
  ) {
    const notification = new Notification(title, {
      body: 'Needs your attention',
      icon: '/favicon.ico',
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
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
  bindClick('btn-close-changelog', closeChangelog);
  bindClick('update-changelog-link', showChangelog);

  const changelogBackdrop = document.querySelector('#changelog-modal .modal-backdrop');
  if (changelogBackdrop) {
    changelogBackdrop.addEventListener('click', closeChangelog);
  }

  bindClick('btn-history', toggleHistoryDropdown);

  import('./modules/settings').then((mod) => {
    mod.bindSettingsAutoSave();
  });
}
