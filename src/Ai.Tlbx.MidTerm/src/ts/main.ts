/**
 * MidTerm Terminal Client
 *
 * Web-based terminal multiplexer frontend using xterm.js.
 * Main entry point - wires together all modules.
 */

import { initLoginPage } from './modules/login';
import { initTrustPage } from './modules/trust';
import { initThemeFromCookie } from './modules/theming';
import { createLogger, initLogConcerns } from './modules/logging';
import { ASSET_VERSION } from './constants';
import {
  connectStateWebSocket,
  connectMuxWebSocket,
  connectSettingsWebSocket,
  handleStateUpdate,
  setSelectSessionCallback,
  sendInput,
  sendActiveSessionHint,
  setSessionBytesCallback,
  setSuppressHeatCallback,
  reportBrowserActivity,
} from './modules/comms';
import { initBadges } from './modules/badges';
import {
  createTerminalForSession,
  destroyTerminalForSession,
  preloadTerminalFont,
  initCalibrationTerminal,
  setShowBellCallback,
  setupResizeObserver,
  setupVisualViewport,
  bindSearchEvents,
  scrollToBottom,
  focusActiveTerminal,
  refreshTerminalPresentation,
  setupGlobalFocusReclaim,
  calculateOptimalDimensions,
  getEffectiveTerminalFontSize,
  handleClipboardPaste,
  pasteToTerminal,
  initMobilePiP,
  recordMobilePiPBytes,
  isTerminalViewingScrollback,
} from './modules/terminal';
import { getConfiguredTerminalFontFamily } from './modules/terminal/fontConfig';
import {
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
  initHeatIndicator,
  recordBytes,
  suppressAllHeat,
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
} from './modules/sidebar';
import { initI18n, t } from './modules/i18n';
import { initTabTitle } from './modules/tabTitle';
import { bindVoiceEvents, initVoiceControls } from './modules/voice';
import { initChatPanel } from './modules/chat';
import { toggleSettings, closeSettings } from './modules/settings';
import { bindAuthEvents } from './modules/auth';
import { fetchBootstrap } from './modules/bootstrap';
import {
  applyUpdate,
  checkForUpdates,
  showChangelog,
  closeChangelog,
  disableChangelogAfterUpdate,
  showUpdateLog,
  dismissUpdateNotification,
  bindFooterUpdateLink,
} from './modules/updating';
import { initDiagnosticsPanel } from './modules/diagnostics';
import {
  initHistoryDropdown,
  toggleHistoryDropdown,
  createHistoryEntry,
  fetchHistory,
  refreshHistory,
  type LaunchEntry,
} from './modules/history';
import { getForegroundInfo, addProcessStateListener } from './modules/process';
import { getInjectGuidancePromptKey } from './modules/midtermGuidance';
import { buildProcessCwdTuple, buildReplayCommand } from './modules/sidebar/processDisplay';
import {
  initTouchController,
  dismissTouchController,
  restoreTouchController,
} from './modules/touchController';
import { initFileViewer } from './modules/fileViewer';
import { initManagerBar } from './modules/managerBar';
import {
  initLayoutRenderer,
  initDockOverlay,
  handleSessionClosed,
  dockSession,
  getLayoutSessionIds,
  isSessionInLayout,
  isLayoutActive,
  focusLayoutSession,
  initLayoutPersistence,
  getLayoutRoot,
} from './modules/layout';
import {
  initSessionTabs,
  ensureSessionWrapper,
  destroySessionWrapper,
  getActiveTab,
  isTabAvailable,
  reparentTerminalContainer,
  switchTab,
} from './modules/sessionTabs';
import {
  initAgentView,
  destroyAgentView,
  getLensDebugScenarioNames,
  showLensDebugScenario,
} from './modules/agentView';
import { initFileBrowser, destroyFileBrowser } from './modules/fileBrowser';
import { initGitPanel, connectGitWebSocket, destroyGitSession } from './modules/git';
import { initCommandsPanel, destroyCommandsSession } from './modules/commands';
import { initWebPreview } from './modules/web';
import {
  attachHubChannel,
  bindHubSettings,
  deleteRemoteSession,
  detachHubChannel,
  getFirstHubSessionId,
  getHubSession,
  getHubSessionRecord,
  initHubRuntime,
  isHubSessionId,
  refreshHubState,
  renameRemoteSession,
  renderHubSettings,
  subscribeHubState,
} from './modules/hub';
import {
  initSessionShareButton,
  isSharedSessionRoute,
  claimSharedSessionAccess,
  fetchSharedBootstrap,
  applySharedSessionMode,
  showSharedSessionError,
} from './modules/share';
import { initDockState, removeSessionDockState } from './modules/dockState';
import { initSmartInput, removeSmartInputSessionState } from './modules/smartInput';
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
  $currentSettings,
  setSession,
  removeSession,
  getSession,
  setProcessState,
  setPendingRename,
  clearPendingRename,
} from './stores';
import type { Session } from './types';
import { MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from './constants';
import { bindClick, getOrCreateClientId } from './utils';
import { showAlert } from './utils/dialog';
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  renameSession as apiRenameSession,
  patchHistoryEntry,
  setSessionBookmark,
  setSessionControl as apiSetSessionControl,
} from './api/client';

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
  layout: {
    dock(
      targetSessionId: string,
      draggedSessionId: string,
      position: 'left' | 'right' | 'top' | 'bottom',
    ) {
      dockSession(targetSessionId, draggedSessionId, position);
    },
    focus(sessionId: string) {
      focusLayoutSession(sessionId);
    },
    get sessions() {
      return getLayoutSessionIds();
    },
    isSessionInLayout(sessionId: string) {
      return isSessionInLayout(sessionId);
    },
    get rootVisible() {
      return !getLayoutRoot()?.classList.contains('hidden');
    },
  },
  lens: {
    get scenarios() {
      return [...getLensDebugScenarioNames()];
    },
    async showScenario(
      sessionId: string,
      scenario: 'mixed' | 'tables' | 'long' = 'mixed',
    ): Promise<boolean> {
      switchTab(sessionId, 'agent');
      await Promise.resolve();
      return showLensDebugScenario(sessionId, scenario);
    },
  },
};

// =============================================================================
// Initialization
// =============================================================================

initThemeFromCookie();

document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  if (path === '/login' || path === '/login.html') {
    void initLoginPage();
  } else if (path === '/trust' || path === '/trust.html') {
    void initTrustPage();
  } else if (isSharedSessionRoute()) {
    void initShared();
  } else {
    void init();
  }
});

async function init(): Promise<void> {
  initLogConcerns();
  log.info(() => 'MidTerm frontend initializing');

  cacheDOMElements();
  await initI18n();
  initTrafficIndicator();
  setSessionBytesCallback((sessionId, bytes) => {
    recordBytes(sessionId, bytes);
    recordMobilePiPBytes(sessionId, bytes);
  });
  setSuppressHeatCallback(suppressAllHeat);
  initHeatIndicator();
  initBadges();
  initFileViewer();
  restoreSidebarState();
  setupSidebarResize();
  initializeSessionList();
  initializeSidebarUpdater();
  initTabTitle();
  initSessionDrag();
  initLayoutRenderer();
  initLayoutPersistence();
  initDockOverlay();
  initHistoryDropdown(
    (entry) => {
      void spawnFromHistory(entry);
    },
    (entryId, newLabel) => {
      const session = $sessionList.get().find((s) => s.bookmarkId === entryId);
      if (session) renameSession(session.id, newLabel || null);
    },
  );

  const fontPromise = preloadTerminalFont();
  setFontsReadyPromise(fontPromise);

  // Initialize calibration terminal after fonts are ready for accurate measurements
  void fontPromise.then(() => initCalibrationTerminal());

  registerCallbacks();
  getOrCreateClientId(); // Ensure mt-client-id cookie exists before WS upgrade
  connectStateWebSocket();
  connectMuxWebSocket();
  connectSettingsWebSocket();

  bindEvents();
  bindAuthEvents();
  bindSearchEvents();
  setupGlobalFocusReclaim();
  initShareAccessButton();
  initNetworkSection();
  initVoiceSection();
  bindVoiceEvents();
  await initVoiceControls();
  initChatPanel();
  syncAppModeClasses();
  setupResizeObserver();
  setupVisualViewport();
  initTouchController();
  initSmartInput();
  initMobilePiP();
  initManagerBar();
  initSessionTabs();
  initAgentView();
  initFileBrowser();
  initGitPanel();
  connectGitWebSocket();
  initCommandsPanel();
  initWebPreview();
  initSessionShareButton();
  initDockState();
  initHubRuntime();
  subscribeHubState(() => {
    renderSessionList();
    updateEmptyState();
    updateMobileTitle();
    syncMobileTabActionState();
    renderHubSettings();
  });

  // Single bootstrap call replaces: fetchVersion, fetchNetworks, fetchSettings,
  // checkAuthStatus, checkUpdateResult, and checkSystemHealth
  void fetchBootstrap();
  requestNotificationPermission();
  initDiagnosticsPanel();
  bindHubSettings();

  setupVisibilityChangeHandler();
  initPwaInstall();

  let serviceWorker: ServiceWorkerContainer | undefined;
  try {
    serviceWorker = navigator.serviceWorker;
  } catch {
    serviceWorker = undefined;
  }

  if (serviceWorker?.register) {
    serviceWorker.register(`/js/sw.js?v=${encodeURIComponent(ASSET_VERSION)}`).catch(() => {});
  }

  log.info(() => 'MidTerm frontend initialized');
}

async function initShared(): Promise<void> {
  initLogConcerns();
  log.info(() => 'MidTerm shared frontend initializing');

  cacheDOMElements();
  await initI18n();

  const fontPromise = preloadTerminalFont();
  setFontsReadyPromise(fontPromise);
  void fontPromise.then(() => initCalibrationTerminal());

  setSelectSessionCallback(selectSession);
  setShowBellCallback(showBellNotification);
  addProcessStateListener((sessionId, state) => {
    setProcessState(sessionId, { ...state });
  });

  initSessionTabs();
  bindSearchEvents();
  setupGlobalFocusReclaim();
  syncAppModeClasses();
  setupResizeObserver();
  setupVisualViewport();
  setupVisibilityChangeHandler();

  try {
    await claimSharedSessionAccess();
    const bootstrap = await fetchSharedBootstrap();
    applySharedSessionMode(bootstrap);
    handleStateUpdate(bootstrap.session ? [bootstrap.session] : []);
  } catch (error) {
    log.error(() => `Shared session bootstrap failed: ${String(error)}`);
    showSharedSessionError(t('share.shared.invalid'));
    return;
  }

  connectStateWebSocket();
  connectMuxWebSocket();

  log.info(() => 'MidTerm shared frontend initialized');
}

// =============================================================================
// Callback Registration
// =============================================================================

function registerCallbacks(): void {
  setSelectSessionCallback(selectSession);
  setShowBellCallback(showBellNotification);

  addProcessStateListener((sessionId, state) => {
    setProcessState(sessionId, { ...state });
  });

  setSessionListCallbacks({
    onSelect: selectSession,
    onDelete: deleteSession,
    onRename: startInlineRename,
    onToggleAgentControl: toggleAgentControl,
    onPinToHistory: (sessionId: string) => {
      void pinSessionToHistory(sessionId);
    },
    onInjectGuidance: (sessionId: string) => {
      void injectGuidance(sessionId);
    },
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
  if (state.reconnectFreezeOverlay) return;
  if (state.terminal.modes.synchronizedOutputMode) return;

  const bufferBefore = state.terminal.buffer.active;
  if (bufferBefore.viewportY >= bufferBefore.baseY) {
    return;
  }

  const scrollPosBefore = bufferBefore.viewportY;

  setTimeout(() => {
    if ($activeSessionId.get() !== activeId) return;
    if (!state.opened || state.container.classList.contains('hidden')) return;
    if (state.reconnectFreezeOverlay) return;
    if (state.terminal.modes.synchronizedOutputMode) return;

    const scrollPosAfter = state.terminal.buffer.active.viewportY;
    const delta = Math.abs(scrollPosAfter - scrollPosBefore);
    if (delta > 50) {
      state.terminal.scrollToLine(scrollPosBefore);
    }
  }, 50);
}

function setupVisibilityChangeHandler(): void {
  document.addEventListener('visibilitychange', () => {
    reportBrowserActivity();

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
    reportBrowserActivity(true);
    applyScrollbackProtection();
  });

  window.addEventListener('blur', () => {
    reportBrowserActivity(false);
  });

  window.addEventListener('pagehide', () => {
    reportBrowserActivity(false);
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
    const fontSize = getEffectiveTerminalFontSize(settings?.fontSize ?? 14);
    const dims = await calculateOptimalDimensions(
      dom.terminalsArea,
      fontSize,
      getConfiguredTerminalFontFamily(),
      settings?.lineHeight ?? 1,
      settings?.letterSpacing ?? 0,
      settings?.fontWeight ?? 'normal',
      settings?.fontWeightBold ?? 'bold',
      tempId,
    );
    if (dims && dims.cols > MIN_TERMINAL_COLS && dims.rows > MIN_TERMINAL_ROWS) {
      cols = dims.cols;
      rows = dims.rows;
    }
  }

  // Optimistic UI: add temporary session with spinner
  const tempSession: Session = {
    id: tempId,
    pid: 0,
    createdAt: new Date().toISOString(),
    isRunning: false,
    exitCode: null,
    name: '',
    terminalTitle: '',
    currentDirectory: '',
    foregroundPid: null,
    foregroundName: null,
    foregroundCommandLine: null,
    foregroundDisplayName: null,
    foregroundProcessIdentity: null,
    shellType: 'Loading...',
    cols: cols,
    rows: rows,
    manuallyNamed: false,
    supervisor: {
      state: 'unknown',
      profile: 'unknown',
      needsAttention: false,
      attentionReason: null,
      attentionScore: 0,
      lastInputAt: null,
      lastOutputAt: null,
      lastBellAt: null,
      currentHeat: 0,
    },
    order: Date.now(),
    parentSessionId: null,
    bookmarkId: null,
    agentControlled: false,
    hasLensHistory: false,
    agentAttachPoint: null,
  };
  setSession(tempSession);
  pendingSessions.add(tempId);
  // Subscription handles renderSessionList via store change
  closeSidebar();

  apiCreateSession({
    cols,
    rows,
    shell: settings?.defaultShell ?? null,
    workingDirectory: settings?.defaultWorkingDirectory || null,
  })
    .then(({ data }) => {
      // Remove temporary session
      pendingSessions.delete(tempId);
      removeSession(tempId);

      if (!data) return;
      setSession(data);
      newlyCreatedSessions.add(data.id);
      selectSession(data.id);
    })
    .catch((e: unknown) => {
      // Remove temporary session on error
      pendingSessions.delete(tempId);
      removeSession(tempId);
      // Subscription handles renderSessionList and updateEmptyState via store change
      log.error(() => `Failed to create session: ${String(e)}`);
    });
}

function selectSession(sessionId: string, options?: { closeSettingsPanel?: boolean }): void {
  closeMobileActionsMenu();

  // Only close settings if explicitly requested (e.g., user clicked a session)
  // Auto-selection from state updates should NOT close settings
  if (options?.closeSettingsPanel !== false) {
    closeSettings();
  }

  if (isHubSessionId(sessionId)) {
    const sessionInfo = getHubSession(sessionId);
    if (!sessionInfo) {
      return;
    }

    detachHubChannel();
    sessionTerminals.forEach((state, id) => {
      if (!isSessionInLayout(id)) {
        state.container.classList.add('hidden');
      }
    });

    $activeSessionId.set(sessionId);
    suppressAllHeat(1500);

    const state = createTerminalForSession(sessionId, sessionInfo);
    const tabState = ensureSessionWrapper(sessionId);
    reparentTerminalContainer(sessionId, state.container);
    if (dom.terminalsArea && !dom.terminalsArea.contains(tabState.wrapper)) {
      dom.terminalsArea.appendChild(tabState.wrapper);
    }

    dom.terminalsArea?.querySelectorAll('.session-wrapper').forEach((w) => {
      (w as HTMLElement).classList.toggle(
        'hidden',
        w.getAttribute('data-session-id') !== sessionId,
      );
    });

    state.container.classList.remove('hidden');
    if (isLayoutActive()) {
      getLayoutRoot()?.classList.add('hidden');
    }

    attachHubChannel(sessionId);

    requestAnimationFrame(() => {
      refreshTerminalPresentation(sessionId, state);
      state.terminal.focus();
      if (!isTerminalViewingScrollback(state)) {
        scrollToBottom(sessionId);
      }
    });

    dom.emptyState?.classList.add('hidden');
    return;
  }

  detachHubChannel();

  // If session is in layout, focus it there instead of switching to standalone
  if (isSessionInLayout(sessionId)) {
    suppressAllHeat(1500);
    focusLayoutSession(sessionId);
    sendActiveSessionHint(sessionId);
    const sessionInfo = getSession(sessionId);
    createTerminalForSession(sessionId, sessionInfo);
    // Re-show layout (may have been hidden for standalone viewing)
    getLayoutRoot()?.classList.remove('hidden');
    sessionTerminals.forEach((s, id) => {
      if (!isSessionInLayout(id)) s.container.classList.add('hidden');
    });
    return;
  }

  // Standalone mode - hide all terminals except selected
  sessionTerminals.forEach((state, id) => {
    // Don't hide terminals that are in the layout
    if (!isSessionInLayout(id)) {
      state.container.classList.add('hidden');
    }
  });

  $activeSessionId.set(sessionId);
  suppressAllHeat(1500);
  sendActiveSessionHint(sessionId);

  const sessionInfo = getSession(sessionId);
  const state = createTerminalForSession(sessionId, sessionInfo);
  const isNewlyCreated = newlyCreatedSessions.has(sessionId);
  const activeTab = getActiveTab(sessionId);

  // Ensure session wrapper with tabs (standalone mode only)
  const tabState = ensureSessionWrapper(sessionId);
  reparentTerminalContainer(sessionId, state.container);
  if (dom.terminalsArea && !dom.terminalsArea.contains(tabState.wrapper)) {
    dom.terminalsArea.appendChild(tabState.wrapper);
  }
  // Hide all other wrappers
  dom.terminalsArea?.querySelectorAll('.session-wrapper').forEach((w) => {
    (w as HTMLElement).classList.toggle('hidden', w.getAttribute('data-session-id') !== sessionId);
  });

  state.container.classList.remove('hidden');
  if (isLayoutActive()) {
    getLayoutRoot()?.classList.add('hidden');
  }

  requestAnimationFrame(() => {
    refreshTerminalPresentation(sessionId, state);
    if (activeTab !== 'agent') {
      state.terminal.focus();
    }
    if (isNewlyCreated || !isTerminalViewingScrollback(state)) {
      scrollToBottom(sessionId);
    }

    if (isNewlyCreated) {
      newlyCreatedSessions.delete(sessionId);
    }
  });

  // Subscription handles renderSessionList and updateMobileTitle via $activeSessionId change
  dom.emptyState?.classList.add('hidden');
}

function deleteSession(sessionId: string): void {
  if (isHubSessionId(sessionId)) {
    const record = getHubSessionRecord(sessionId);
    destroySessionWrapper(sessionId);
    destroyTerminalForSession(sessionId);
    if ($activeSessionId.get() === sessionId) {
      $activeSessionId.set(null);
    }
    detachHubChannel(sessionId);
    if (record) {
      deleteRemoteSession(record.machineId, record.remoteSessionId)
        .then(() => refreshHubState())
        .catch((e: unknown) => {
          log.error(() => `Failed to delete remote session ${sessionId}: ${String(e)}`);
        });
    }

    const nextLocal = $sessionList.get()[0]?.id ?? getFirstHubSessionId();
    if (nextLocal) {
      selectSession(nextLocal, { closeSettingsPanel: false });
    }
    return;
  }

  // Remove from layout if present
  handleSessionClosed(sessionId);

  // Remove session tab wrapper, feature panels, and dock state
  removeSessionDockState(sessionId);
  removeSmartInputSessionState(sessionId);
  destroyAgentView(sessionId);
  destroyFileBrowser(sessionId);
  destroyGitSession(sessionId);
  destroyCommandsSession(sessionId);
  destroySessionWrapper(sessionId);

  // Optimistic UI: remove session immediately for better UX
  destroyTerminalForSession(sessionId);

  // Remove from sessions store
  removeSession(sessionId);

  // If this was the active session, select another (but don't close settings panel)
  if ($activeSessionId.get() === sessionId) {
    $activeSessionId.set(null);
    const sessions = $sessionList.get();
    const firstSession = sessions[0];
    if (firstSession?.id) {
      selectSession(firstSession.id, { closeSettingsPanel: false });
    }
  }

  // Subscription handles renderSessionList, updateEmptyState, updateMobileTitle via store change

  // Send delete request to server
  apiDeleteSession(sessionId).catch((e: unknown) => {
    log.error(() => `Failed to delete session ${sessionId}: ${String(e)}`);
  });
}

async function injectGuidance(sessionId: string): Promise<void> {
  if (isHubSessionId(sessionId)) {
    return;
  }

  try {
    const res = await fetch(`/api/sessions/${sessionId}/inject-guidance`, { method: 'POST' });
    if (!res.ok) {
      log.warn(() => `Inject guidance failed: ${res.status}`);
      return;
    }

    const fg = getForegroundInfo(sessionId);
    await pasteToTerminal(sessionId, t(getInjectGuidancePromptKey(fg.name)));
  } catch (e: unknown) {
    log.error(() => `Failed to inject guidance for ${sessionId}: ${String(e)}`);
  }
}

function renameSession(sessionId: string, newName: string | null): void {
  if (isHubSessionId(sessionId)) {
    const record = getHubSessionRecord(sessionId);
    if (!record) return;

    const trimmedName = (newName || '').trim();
    renameRemoteSession(record.machineId, record.remoteSessionId, { name: trimmedName })
      .then(() => refreshHubState())
      .catch((e: unknown) => {
        log.error(() => `Failed to rename remote session ${sessionId}: ${String(e)}`);
      });
    return;
  }

  const session = getSession(sessionId);
  if (!session) return;

  const trimmedName = (newName || '').trim();
  const nameToSend = trimmedName === '' || trimmedName === session.shellType ? '' : trimmedName;

  // Store previous values for rollback
  const previousName = session.name;
  const wasManuallyNamed = session.manuallyNamed;

  // Mark as pending to protect from server overwrites until confirmed
  setPendingRename(sessionId, nameToSend);

  // Optimistic UI update via store
  setSession({ ...session, name: nameToSend, manuallyNamed: true });
  // Subscription handles renderSessionList and updateMobileTitle via store change

  apiRenameSession(sessionId, nameToSend)
    .then(() => {
      void patchPinnedHistoryLabelIfMatchingTuple(sessionId, nameToSend);
    })
    .catch((e: unknown) => {
      // Clear pending and rollback on error
      clearPendingRename(sessionId);
      const currentSession = getSession(sessionId);
      if (currentSession) {
        setSession({ ...currentSession, name: previousName, manuallyNamed: wasManuallyNamed });
      }
      // Subscription handles renderSessionList and updateMobileTitle via store change
      log.error(() => `Failed to rename session ${sessionId}: ${String(e)}`);
    });
}

function getSessionFamilyIds(sessionId: string): string[] {
  const sessions = $sessionList.get();
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) {
    return [];
  }

  const rootSessionId = session.parentSessionId ?? session.id;
  return sessions
    .filter((item) => item.id === rootSessionId || item.parentSessionId === rootSessionId)
    .map((item) => item.id)
    .filter((id): id is string => !!id);
}

function toggleAgentControl(sessionId: string): void {
  if (isHubSessionId(sessionId)) {
    return;
  }

  const session = getSession(sessionId);
  if (!session) return;

  const nextAgentControlled = !session.agentControlled;
  const sessionFamilyIds = getSessionFamilyIds(sessionId);
  const previousSnapshots = sessionFamilyIds
    .map((id) => getSession(id))
    .filter((item): item is Session => !!item)
    .map((item) => ({ ...item }));

  for (const snapshot of previousSnapshots) {
    setSession({
      ...snapshot,
      agentControlled: nextAgentControlled,
    });
  }

  apiSetSessionControl(sessionId, nextAgentControlled).catch((e: unknown) => {
    for (const snapshot of previousSnapshots) {
      setSession(snapshot);
    }

    log.error(() => `Failed to toggle agent control for ${sessionId}: ${String(e)}`);
  });
}

async function patchPinnedHistoryLabelIfMatchingTuple(
  sessionId: string,
  nameToSend: string,
): Promise<void> {
  const currentSession = getSession(sessionId);
  const bookmarkId = currentSession?.bookmarkId;
  if (!bookmarkId) return;

  const fgInfo = getForegroundInfo(sessionId);
  const currentTuple = buildProcessCwdTuple(
    fgInfo.name,
    fgInfo.commandLine,
    fgInfo.cwd,
    fgInfo.processIdentity,
  );
  if (!currentTuple) return;

  let entries: LaunchEntry[];
  try {
    entries = await fetchHistory();
  } catch {
    return;
  }

  const linkedEntry = entries.find((e) => e.id === bookmarkId);
  if (!linkedEntry) return;

  const linkedTuple = buildProcessCwdTuple(
    linkedEntry.executable,
    linkedEntry.commandLine ?? null,
    linkedEntry.workingDirectory,
  );

  if (!linkedTuple || linkedTuple !== currentTuple) {
    log.verbose(() => `Skip bookmark label patch for ${sessionId}: tuple moved`);
    return;
  }

  patchHistoryEntry(bookmarkId, { label: nameToSend || '' }).catch(() => {});
}

function startInlineRename(sessionId: string): void {
  const item = dom.sessionList?.querySelector(`[data-session-id="${sessionId}"]`);
  if (!item) return;

  const renameAnchor =
    item.querySelector('.session-title') ||
    item.querySelector('.process-title') ||
    item.querySelector('.session-title-row');
  if (!renameAnchor) return;

  const session = getSession(sessionId);
  const currentName = session ? session.name || session.shellType : '';

  // Position overlay input on top of the title content.
  const rect = renameAnchor.getBoundingClientRect();

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = currentName;
  input.style.position = 'fixed';
  input.style.left = `${rect.left}px`;
  input.style.top = `${rect.top}px`;
  input.style.width = `${rect.width + 20}px`;
  input.style.height = `${rect.height}px`;
  input.style.zIndex = '10000';

  document.body.appendChild(input);

  let committed = false;
  function finishRename(): void {
    if (committed) return;
    committed = true;
    const newName = input.value;
    input.remove();
    renameSession(sessionId, newName);
  }

  function cancelRename(): void {
    if (committed) return;
    committed = true;
    input.remove();
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
  const tupleKey = buildProcessCwdTuple(
    fgInfo.name,
    fgInfo.commandLine,
    fgInfo.cwd,
    fgInfo.processIdentity,
  );
  if (!fgInfo.name || !tupleKey) {
    log.info(() => `pinSessionToHistory: missing process tuple for ${sessionId}`);
    return;
  }

  const trimmedName = (session.name || '').trim();
  const label = trimmedName && trimmedName !== session.shellType ? trimmedName : null;
  const previousBookmarkId = session.bookmarkId ?? null;

  const id = await createHistoryEntry({
    shellType: session.shellType,
    executable: fgInfo.name,
    commandLine: fgInfo.commandLine,
    workingDirectory: fgInfo.cwd ?? '',
    isStarred: true,
    label,
    dedupeKey: tupleKey,
  });

  if (id) {
    const current = getSession(sessionId) ?? session;
    const bookmarkChanged = current.bookmarkId !== id;

    if (bookmarkChanged) {
      setSession({ ...current, bookmarkId: id });
      setSessionBookmark(sessionId, id).catch(() => {});
    }

    refreshHistory();
    if (previousBookmarkId && previousBookmarkId !== id) {
      log.info(() => `Pinned to history (new tuple): ${fgInfo.name} (id=${id})`);
    } else if (previousBookmarkId === id) {
      log.info(() => `Pinned to history (updated existing tuple): ${fgInfo.name} (id=${id})`);
    } else {
      log.info(() => `Pinned to history: ${fgInfo.name} (id=${id})`);
    }
  }
}

async function spawnFromHistory(entry: LaunchEntry): Promise<void> {
  const settings = $currentSettings.get();
  let cols = settings?.defaultCols ?? 120;
  let rows = settings?.defaultRows ?? 30;

  if (dom.terminalsArea) {
    const fontSize = getEffectiveTerminalFontSize(settings?.fontSize ?? 14);
    const logId = 'history-' + crypto.randomUUID().slice(0, 8);
    const dims = await calculateOptimalDimensions(
      dom.terminalsArea,
      fontSize,
      getConfiguredTerminalFontFamily(),
      settings?.lineHeight ?? 1,
      settings?.letterSpacing ?? 0,
      settings?.fontWeight ?? 'normal',
      settings?.fontWeightBold ?? 'bold',
      logId,
    );
    if (dims && dims.cols > MIN_TERMINAL_COLS && dims.rows > MIN_TERMINAL_ROWS) {
      cols = dims.cols;
      rows = dims.rows;
    }
  }

  closeSidebar();

  apiCreateSession({
    cols,
    rows,
    shell: entry.shellType || null,
    workingDirectory: entry.workingDirectory || null,
  })
    .then(({ data }) => {
      if (!data) return;
      setSession(data);
      newlyCreatedSessions.add(data.id);
      selectSession(data.id);

      // Link session to bookmark and apply label (deferred until session is in store)
      const applyBookmark = (): void => {
        const session = getSession(data.id);
        if (!session) {
          setTimeout(applyBookmark, 100);
          return;
        }
        setSession({ ...session, bookmarkId: entry.id });
        if (entry.id) {
          setSessionBookmark(data.id, entry.id).catch(() => {});
        }
        if (entry.label) {
          renameSession(data.id, entry.label);
        }
      };
      applyBookmark();

      if (entry.commandLine) {
        const replayCmd = buildReplayCommand(entry.executable, entry.commandLine);
        setTimeout(() => {
          sendInput(data.id, replayCmd + '\r');
        }, 100);
      }
    })
    .catch((e: unknown) => {
      log.error(() => `Failed to spawn from history: ${String(e)}`);
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

  const bellStyle = settings.bellStyle;
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
// PWA Install
// =============================================================================

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function initPwaInstall(): void {
  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  const row = document.getElementById('pwa-install-row');
  const btn = document.getElementById('btn-install-pwa') as HTMLButtonElement | null;
  if (!row || !btn) return;

  const rowEl = row;
  const btnEl = btn;
  const isIos = isIosInstallableDevice();

  function showRow(): void {
    rowEl.classList.remove('hidden');
  }

  function hideRow(): void {
    rowEl.classList.add('hidden');
  }

  function setButtonLabel(key: string): void {
    btnEl.dataset.i18n = key;
    btnEl.textContent = t(key);
  }

  if (isRunningAsInstalledPwa()) {
    hideRow();
    return;
  }

  if (isIos) {
    showRow();
    setButtonLabel('settings.behavior.showInstallSteps');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    setButtonLabel('settings.behavior.install');
    showRow();
  });

  btn.addEventListener('click', () => {
    if (deferredPrompt) {
      void deferredPrompt.prompt().then(() => {
        deferredPrompt = null;
        hideRow();
      });
      return;
    }

    if (!isIos) return;

    void showAlert(t('settings.behavior.installIosMessage'), {
      title: t('settings.behavior.installIosTitle'),
    });
  });

  window.addEventListener('appinstalled', () => {
    hideRow();
    deferredPrompt = null;
    syncAppModeClasses();
  });
}

function isIosInstallableDevice(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return (
    /iphone|ipad|ipod/.test(ua) ||
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isRunningAsInstalledPwa(): boolean {
  const standaloneNavigator = navigator as NavigatorWithStandalone;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    standaloneNavigator.standalone === true
  );
}

function syncAppModeClasses(): void {
  document.body.classList.toggle('installed-pwa', isRunningAsInstalledPwa());
  document.body.classList.toggle('ios-installable-device', isIosInstallableDevice());
}

function getActiveSessionTabBar(): HTMLDivElement | null {
  const activeSessionId = $activeSessionId.get();
  if (!activeSessionId || !dom.terminalsArea) return null;

  const wrappers = dom.terminalsArea.querySelectorAll<HTMLDivElement>('.session-wrapper');
  for (const wrapper of wrappers) {
    if (wrapper.dataset.sessionId === activeSessionId) {
      return wrapper.querySelector<HTMLDivElement>('.session-tab-bar');
    }
  }
  return null;
}

function clickActiveSessionTabBarControl(selector: string): void {
  const tabBar = getActiveSessionTabBar();
  if (!tabBar) return;
  const control = tabBar.querySelector<HTMLButtonElement>(selector);
  control?.click();
}

function syncMobileTabActionState(): void {
  const activeSessionId = $activeSessionId.get();
  const activeTab = activeSessionId ? getActiveTab(activeSessionId) : null;
  const agentVisible = activeSessionId ? isTabAvailable(activeSessionId, 'agent') : false;
  const strip = document.getElementById('mobile-tab-strip');
  const topbar = document.getElementById('mobile-topbar');
  const title = document.getElementById('mobile-title');

  const syncButton = (
    elementId: string,
    options: {
      active: boolean;
      hidden?: boolean;
    },
  ): void => {
    const button = document.getElementById(elementId);
    if (!button) {
      return;
    }

    button.classList.toggle('active', options.active);
    if (typeof options.hidden === 'boolean') {
      button.toggleAttribute('hidden', options.hidden);
    }
  };

  strip?.toggleAttribute('hidden', !activeSessionId);
  title?.toggleAttribute('hidden', Boolean(activeSessionId));
  topbar?.classList.toggle('has-mobile-tabs', Boolean(activeSessionId));
  syncButton('btn-mobile-tab-terminal', { active: activeTab === 'terminal' });
  syncButton('btn-mobile-tab-agent', { active: activeTab === 'agent', hidden: !agentVisible });
  syncButton('btn-mobile-tab-files', { active: activeTab === 'files' });
  syncButton('btn-mobile-strip-terminal', { active: activeTab === 'terminal' });
  syncButton('btn-mobile-strip-agent', { active: activeTab === 'agent', hidden: !agentVisible });
  syncButton('btn-mobile-strip-files', { active: activeTab === 'files' });
}

function activateMobileTab(tab: 'terminal' | 'agent' | 'files'): void {
  const activeId = $activeSessionId.get();
  if (!activeId) {
    return;
  }

  if (tab === 'agent' && !isTabAvailable(activeId, 'agent')) {
    return;
  }

  switchTab(activeId, tab);
  syncMobileTabActionState();
}

function closeMobileActionsMenu(): void {
  const toggleBtn = document.getElementById('btn-mobile-actions-menu');
  const dropdown = document.getElementById('mobile-actions-dropdown');
  if (!toggleBtn || !dropdown) return;

  dropdown.setAttribute('hidden', '');
  toggleBtn.setAttribute('aria-expanded', 'false');
}

function toggleMobileActionsMenu(): void {
  const toggleBtn = document.getElementById('btn-mobile-actions-menu');
  const dropdown = document.getElementById('mobile-actions-dropdown');
  if (!toggleBtn || !dropdown) return;

  const isOpen = !dropdown.hasAttribute('hidden');
  if (isOpen) {
    closeMobileActionsMenu();
    return;
  }

  syncMobileTabActionState();
  dropdown.removeAttribute('hidden');
  toggleBtn.setAttribute('aria-expanded', 'true');
}

function bindMobileActionsMenu(): void {
  const toggleBtn = document.getElementById('btn-mobile-actions-menu');
  const dropdown = document.getElementById('mobile-actions-dropdown');
  const actions = document.getElementById('topbar-actions');
  if (!toggleBtn || !dropdown || !actions) return;

  // Ensure deterministic closed state on startup/hot reload.
  closeMobileActionsMenu();

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMobileActionsMenu();
  });

  dropdown.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) {
      closeMobileActionsMenu();
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (target && !actions.contains(target)) {
      closeMobileActionsMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMobileActionsMenu();
    }
  });

  window.addEventListener('orientationchange', closeMobileActionsMenu);
}

// =============================================================================
// Event Binding
// =============================================================================

function bindEvents(): void {
  bindClick('btn-new-session', () => {
    void createSession();
  });
  bindClick('btn-new-session-mobile', () => {
    void createSession();
  });
  bindClick('btn-create-terminal', () => {
    void createSession();
  });

  bindClick('btn-dismiss-touchbar', dismissTouchController);
  bindClick('btn-show-touchbar', restoreTouchController);

  bindClick('btn-hamburger', toggleSidebar);
  bindClick('btn-collapse-sidebar', collapseSidebar);
  bindClick('btn-expand-sidebar', expandSidebar);
  bindMobileActionsMenu();

  if (dom.sidebarOverlay) {
    dom.sidebarOverlay.addEventListener('click', closeSidebar);
  }

  bindClick('btn-ctrlc-mobile', () => {
    const activeId = $activeSessionId.get();
    if (activeId) sendInput(activeId, '\x03');
  });
  bindClick('btn-paste-mobile', () => {
    const activeId = $activeSessionId.get();
    if (!activeId) return;
    const foreground = getForegroundInfo(activeId);
    void handleClipboardPaste(activeId, {
      foregroundName: foreground.name,
      foregroundCommandLine: foreground.commandLine,
    }).finally(() => {
      focusActiveTerminal();
    });
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
  bindClick('btn-inject-mobile', () => {
    const activeId = $activeSessionId.get();
    if (activeId) void injectGuidance(activeId);
  });
  bindClick('btn-mobile-tab-terminal', () => {
    activateMobileTab('terminal');
  });
  bindClick('btn-mobile-tab-agent', () => {
    activateMobileTab('agent');
  });
  bindClick('btn-mobile-tab-files', () => {
    activateMobileTab('files');
  });
  bindClick('btn-mobile-strip-terminal', () => {
    activateMobileTab('terminal');
  });
  bindClick('btn-mobile-strip-agent', () => {
    activateMobileTab('agent');
  });
  bindClick('btn-mobile-strip-files', () => {
    activateMobileTab('files');
  });
  bindClick('btn-mobile-web', () => {
    clickActiveSessionTabBarControl('[data-action="web"]');
  });
  bindClick('btn-mobile-commands', () => {
    clickActiveSessionTabBarControl('[data-action="commands"]');
  });
  bindClick('btn-mobile-share', () => {
    clickActiveSessionTabBarControl('[data-action="share"]');
  });
  bindClick('btn-mobile-git', () => {
    clickActiveSessionTabBarControl('[data-action="git"]');
  });

  // Fullscreen toggle (mobile) - hide button if API not supported
  const fullscreenBtn = document.getElementById('btn-fullscreen-mobile');
  if (document.fullscreenEnabled) {
    bindClick('btn-fullscreen-mobile', () => {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    });

    document.addEventListener('fullscreenchange', () => {
      const iconEl = fullscreenBtn?.querySelector('.icon');
      if (iconEl) {
        iconEl.textContent = document.fullscreenElement ? '\ue920' : '\ue90c';
      }
    });
  } else if (fullscreenBtn) {
    fullscreenBtn.style.display = 'none';
  }

  if (dom.settingsBtn) {
    dom.settingsBtn.addEventListener('click', toggleSettings);
  }

  bindClick('update-btn', applyUpdate);
  bindClick('btn-check-updates', checkForUpdates);
  bindClick('btn-apply-update', applyUpdate);
  bindClick('btn-show-changelog', () => {
    showChangelog();
  });
  bindClick('btn-view-update-log', () => {
    void showUpdateLog();
  });
  bindClick('btn-close-changelog', closeChangelog);
  bindClick('btn-changelog-dont-show', disableChangelogAfterUpdate);
  bindClick('update-changelog-link', () => {
    showChangelog();
  });
  bindClick('update-dismiss-btn', dismissUpdateNotification);
  bindFooterUpdateLink();

  const changelogBackdrop = document.querySelector('#changelog-modal .modal-backdrop');
  if (changelogBackdrop) {
    changelogBackdrop.addEventListener('click', closeChangelog);
  }

  bindClick('btn-history', toggleHistoryDropdown);

  // Global keyboard shortcut: Alt+T to create new terminal
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      void createSession();
    }
  });
}
