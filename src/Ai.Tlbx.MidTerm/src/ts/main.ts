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
  requestBufferRefresh,
  updateTerminalVisibility,
  setSuppressHeatCallback,
  reportBrowserActivity,
} from './modules/comms';
import { initBadges } from './modules/badges';
import {
  preloadTerminalFont,
  initCalibrationTerminal,
  setShowBellCallback,
  setupResizeObserver,
  setupVisualViewport,
  bindSearchEvents,
  focusActiveTerminal,
  setupGlobalFocusReclaim,
  handleClipboardPaste,
  initMobilePiP,
  resolveLaunchDimensions,
} from './modules/terminal';
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
  suppressAllHeat,
  renderSessionList,
  updateEmptyState,
  updateMobileTitle,
} from './modules/sidebar';
import { initI18n, t } from './modules/i18n';
import { initTabTitle } from './modules/tabTitle';
import { bindVoiceEvents, initVoiceControls } from './modules/voice';
import { initChatPanel } from './modules/chat';
import { toggleSettings } from './modules/settings';
import { bindAuthEvents } from './modules/auth';
import { fetchBootstrap, getBootstrapData } from './modules/bootstrap';
import {
  checkForUpdates,
  showChangelog,
  closeChangelog,
  disableChangelogAfterUpdate,
  showUpdateLog,
  dismissUpdateNotification,
  bindFooterUpdateLink,
  clearPendingAppRefreshMarker,
  handlePrimaryUpdateAction,
  initAppShellStatePersistence,
  initUpdateRuntime,
  initUpdateUi,
} from './modules/updating';
import { initDiagnosticsPanel } from './modules/diagnostics';
import { initHistoryDropdown, toggleHistoryDropdown, type LaunchEntry } from './modules/history';
import { isLensHistoryEntry, normalizeHistoryLensProfile } from './modules/history/launchMode';
import { getForegroundInfo, addProcessStateListener } from './modules/process';
import { buildReplayCommand } from './modules/sidebar/processDisplay';
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
  getActiveTab,
  getTabLabelForSession,
  isTabAvailable,
  setSessionLensAvailability,
  switchTab,
} from './modules/sessionTabs';
import { getAgentSurfaceLabel, resolveSessionSurfaceMode } from './modules/sessionSurface';
import {
  initAgentView,
  getLensDebugScenarioNames,
  showLensDebugScenario,
} from './modules/agentView';
import { openSessionLauncher, type SessionLauncherSelection } from './modules/sessionLauncher';
import { initFileBrowser } from './modules/fileBrowser';
import { initGitPanel, connectGitWebSocket } from './modules/git';
import { initCommandsPanel } from './modules/commands';
import { initWebPreview } from './modules/web';
import { initBackButtonGuard } from './modules/navigation/backButtonGuard';
import {
  bindHubSettings,
  createRemoteSession,
  initHubRuntime,
  isHubSessionId,
  refreshHubState,
  renderHubSettings,
  subscribeHubState,
  toHubCompositeId,
} from './modules/hub';
import {
  initSessionShareButton,
  isSharedSessionRoute,
  claimSharedSessionAccess,
  fetchSharedBootstrap,
  applySharedSessionMode,
  showSharedSessionError,
} from './modules/share';
import { initDockState } from './modules/dockState';
import { initSmartInput, setLensResumeConversationHandler } from './modules/smartInput';
import { openProviderResumePicker, type ResumeProvider } from './modules/providerResume';
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
  $settingsOpen,
  $sessionList,
  $currentSettings,
  $layout,
  setSession,
  removeSession,
  getSession,
  setProcessState,
} from './stores';
import type { Session } from './types';
import { bindClick, getOrCreateClientId } from './utils';
import { showAlert } from './utils/dialog';
import { createSessionActionHandlers } from './sessionActions';
import { getSessionLaunchErrorMessage, showSessionLaunchFailure } from './sessionLaunchErrors';
import {
  createSession as apiCreateSession,
  bootstrapWorker,
  setSessionBookmark,
} from './api/client';
import type { ShellType } from './api/types';

// Create logger for main module
const log = createLogger('main');
const PIN_SUCCESS_ANIMATION_MS = 560;

function getBookmarkSurfaceType(
  session: Session,
  profile: 'codex' | 'claude' | null,
): 'trm' | 'cdx' | 'cld' {
  if (session.lensOnly && profile === 'claude') {
    return 'cld';
  }

  if (session.lensOnly && profile === 'codex') {
    return 'cdx';
  }

  return 'trm';
}

function animateBookmarkSaveSuccess(sessionId: string): void {
  const pinButtons = document.querySelectorAll<HTMLButtonElement>(
    `.session-item[data-session-id="${sessionId}"] .session-pin`,
  );
  for (const pinButton of pinButtons) {
    pinButton.classList.remove('save-success');
    void pinButton.offsetWidth;
    pinButton.classList.add('save-success');
    window.setTimeout(() => {
      pinButton.classList.remove('save-success');
    }, PIN_SUCCESS_ANIMATION_MS);
  }
}

function attachBookmarkToSession(
  sessionId: string,
  bookmarkId: string | null,
  label: string | null,
): void {
  if (!bookmarkId && !label) {
    return;
  }

  const applyBookmark = (): void => {
    const session = getSession(sessionId);
    if (!session) {
      setTimeout(applyBookmark, 100);
      return;
    }

    if (bookmarkId) {
      setSession({ ...session, bookmarkId });
      setSessionBookmark(sessionId, bookmarkId).catch(() => {});
    }

    if (label) {
      renameSession(sessionId, label);
    }
  };

  applyBookmark();
}

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
      scenario: 'mixed' | 'tables' | 'long' | 'workflow' = 'mixed',
    ): Promise<boolean> {
      setSessionLensAvailability(sessionId, true);
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
clearPendingAppRefreshMarker();

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
  initBackButtonGuard();

  cacheDOMElements();
  await initI18n();
  initUpdateUi();
  initUpdateRuntime();
  initAppShellStatePersistence();
  initTrafficIndicator();
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
  bindTerminalVisibilitySync();
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
  initBackButtonGuard();

  cacheDOMElements();
  await initI18n();
  initUpdateUi();
  initUpdateRuntime();
  initAppShellStatePersistence();

  const fontPromise = preloadTerminalFont();
  setFontsReadyPromise(fontPromise);
  void fontPromise.then(() => initCalibrationTerminal());

  setSelectSessionCallback(selectSession);
  setShowBellCallback(showBellNotification);
  addProcessStateListener((sessionId, state) => {
    setProcessState(sessionId, { ...state });
  });

  initSessionTabs();
  bindTerminalVisibilitySync();
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

function getVisibleTerminalSessionIds(): string[] {
  if ($settingsOpen.get()) {
    return [];
  }

  if (!isLayoutActive() || getLayoutRoot()?.classList.contains('hidden')) {
    return [];
  }

  return getLayoutSessionIds().filter((sessionId) => !isHubSessionId(sessionId));
}

function syncMuxTerminalVisibility(): void {
  updateTerminalVisibility($activeSessionId.get(), getVisibleTerminalSessionIds());
}

function refreshHiddenSessionsForFullReplay(): void {
  const activeSessionId = $activeSessionId.get();
  const visibleSessionIds = new Set(getVisibleTerminalSessionIds());

  sessionTerminals.forEach((_state, sessionId) => {
    if (
      isHubSessionId(sessionId) ||
      sessionId === activeSessionId ||
      visibleSessionIds.has(sessionId)
    ) {
      return;
    }

    requestBufferRefresh(sessionId);
  });
}

function bindTerminalVisibilitySync(): void {
  syncMuxTerminalVisibility();

  $activeSessionId.subscribe(() => {
    syncMuxTerminalVisibility();
  });

  $layout.subscribe(() => {
    syncMuxTerminalVisibility();
  });

  $settingsOpen.subscribe(() => {
    syncMuxTerminalVisibility();
  });

  let lastResumeMode = $currentSettings.get()?.resumeMode ?? null;
  $currentSettings.subscribe((settings) => {
    const nextResumeMode = settings?.resumeMode ?? null;
    if (lastResumeMode === 'quickResume' && nextResumeMode === 'fullReplay') {
      refreshHiddenSessionsForFullReplay();
    }
    lastResumeMode = nextResumeMode;
    syncMuxTerminalVisibility();
  });
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
    onEnableMidtermFeatures: (sessionId: string) => {
      void enableMidtermFeatures(sessionId);
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

async function resolveNewSessionDimensions(): Promise<{ cols: number; rows: number }> {
  return resolveLaunchDimensions($currentSettings.get(), 'launcher');
}

function createPendingSession(cols: number, rows: number): string {
  const tempId = 'pending-' + crypto.randomUUID();
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
    cols,
    rows,
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
    lensOnly: false,
    profileHint: null,
    lensResumeThreadId: null,
    hasLensHistory: false,
    agentAttachPoint: null,
  };

  setSession(tempSession);
  pendingSessions.add(tempId);
  return tempId;
}

function clearPendingSession(tempId: string): void {
  pendingSessions.delete(tempId);
  removeSession(tempId);
}

function resolveLauncherShell(): ShellType | null {
  const settings = $currentSettings.get();
  if (settings?.defaultShell) {
    return settings.defaultShell;
  }

  const platform = getBootstrapData()?.platform.toLowerCase();
  if (platform === 'windows') {
    return 'Pwsh';
  }

  if (platform === 'macos') {
    return 'Zsh';
  }

  return 'Bash';
}

function isLensOnlySession(session: Session | null | undefined): boolean {
  return session?.lensOnly === true;
}

const {
  deleteSession,
  enableMidtermFeatures,
  pinSessionToHistory,
  promptRenameSession,
  renameSession,
  selectSession,
  startInlineRename,
  toggleAgentControl,
} = createSessionActionHandlers({
  animateBookmarkSaveSuccess,
  buildLensHistoryDedupeKey,
  closeMobileActionsMenu,
  getBookmarkSurfaceType,
  isLensOnlySession,
});
setLensResumeConversationHandler((args) => {
  void resumeLensConversationFromCommandBay(args);
});

async function createSession(): Promise<void> {
  let selection: SessionLauncherSelection | null;
  try {
    selection = await openSessionLauncher();
  } catch (error) {
    void showAlert(getSessionLaunchErrorMessage(error), {
      title: t('sessionLauncher.loadFailed'),
    });
    return;
  }

  if (!selection) {
    return;
  }

  const { cols, rows } = await resolveNewSessionDimensions();
  const tempId = createPendingSession(cols, rows);
  const shell = resolveLauncherShell();
  const workingDirectory = selection.workingDirectory?.trim() || undefined;
  const createSessionRequest = {
    cols,
    rows,
    shell,
    ...(workingDirectory ? { workingDirectory } : {}),
  };
  closeSidebar();

  const target = selection.target;
  if (target.kind === 'hub') {
    if (selection.provider !== 'terminal') {
      clearPendingSession(tempId);
      void showAlert(t('sessionLauncher.remoteTerminalOnly'), {
        title: t('sessionLauncher.createFailed'),
      });
      return;
    }

    createRemoteSession(target.machineId, createSessionRequest)
      .then(async (session) => {
        await refreshHubState();
        clearPendingSession(tempId);
        const compositeId = toHubCompositeId(target.machineId, session.id);
        newlyCreatedSessions.add(compositeId);
        selectSession(compositeId);
      })
      .catch((e: unknown) => {
        clearPendingSession(tempId);
        log.error(() => `Failed to create remote session: ${String(e)}`);
        void showAlert(getSessionLaunchErrorMessage(e), {
          title: t('sessionLauncher.createFailed'),
        });
      });
    return;
  }

  if (selection.provider === 'terminal') {
    apiCreateSession(createSessionRequest)
      .then(({ data }) => {
        clearPendingSession(tempId);
        if (!data) {
          return;
        }

        setSession(data);
        newlyCreatedSessions.add(data.id);
        selectSession(data.id);
      })
      .catch((e: unknown) => {
        clearPendingSession(tempId);
        log.error(() => `Failed to create session: ${String(e)}`);
        showSessionLaunchFailure(e);
      });
    return;
  }

  bootstrapWorker({
    ...createSessionRequest,
    agentControlled: false,
    injectGuidance: true,
    profile: selection.provider,
    resumeThreadId: selection.resumeThreadId ?? null,
    lensOnly: true,
    launchDelayMs: 0,
    slashCommands: [],
    slashCommandDelayMs: 350,
  })
    .then(({ data }) => {
      clearPendingSession(tempId);
      const session = data?.session;
      if (!session) {
        return;
      }

      setSession(session);
      newlyCreatedSessions.add(session.id);
      setSessionLensAvailability(session.id, true);
      selectSession(session.id);
      requestAnimationFrame(() => {
        switchTab(session.id, 'agent');
      });
    })
    .catch((e: unknown) => {
      clearPendingSession(tempId);
      log.error(() => `Failed to create worker session: ${String(e)}`);
      showSessionLaunchFailure(e);
    });
}

async function spawnFromHistory(entry: LaunchEntry): Promise<void> {
  const { cols, rows } = await resolveLaunchDimensions($currentSettings.get(), 'history');

  closeSidebar();

  if (isLensHistoryEntry(entry)) {
    const profile = normalizeHistoryLensProfile(entry.profile);
    if (profile) {
      bootstrapWorker({
        cols,
        rows,
        shell: resolveLauncherShell(),
        workingDirectory: entry.workingDirectory || null,
        agentControlled: false,
        injectGuidance: true,
        profile,
        lensOnly: true,
        launchDelayMs: 0,
        slashCommands: [],
        slashCommandDelayMs: 350,
      })
        .then(({ data }) => {
          const session = data?.session;
          if (!session) {
            return;
          }

          setSession(session);
          newlyCreatedSessions.add(session.id);
          setSessionLensAvailability(session.id, true);
          selectSession(session.id);
          requestAnimationFrame(() => {
            switchTab(session.id, 'agent');
          });
          attachBookmarkToSession(session.id, entry.id, entry.label ?? null);
        })
        .catch((e: unknown) => {
          log.error(() => `Failed to spawn lens bookmark: ${String(e)}`);
          showSessionLaunchFailure(e);
        });
      return;
    }
  }

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
      attachBookmarkToSession(data.id, entry.id, entry.label ?? null);

      if (entry.commandLine) {
        const replayCmd = buildReplayCommand(entry.executable, entry.commandLine);
        setTimeout(() => {
          sendInput(data.id, replayCmd + '\r');
        }, 100);
      }
    })
    .catch((e: unknown) => {
      log.error(() => `Failed to spawn from history: ${String(e)}`);
      showSessionLaunchFailure(e);
    });
}

async function resumeLensConversationFromCommandBay(args: {
  sessionId: string;
  provider: ResumeProvider;
  workingDirectory: string;
}): Promise<void> {
  const sourceSession = getSession(args.sessionId);
  if (!sourceSession) {
    return;
  }

  const candidate = await openProviderResumePicker({
    provider: args.provider,
    workingDirectory: args.workingDirectory,
    initialScope: 'current',
  });
  if (!candidate) {
    return;
  }

  const { cols, rows } = await resolveLaunchDimensions($currentSettings.get(), 'history');
  const tempId = createPendingSession(cols, rows);

  bootstrapWorker({
    cols,
    rows,
    shell: resolveLauncherShell(),
    workingDirectory: args.workingDirectory,
    agentControlled: false,
    injectGuidance: true,
    profile: args.provider,
    resumeThreadId: candidate.sessionId,
    lensOnly: true,
    launchDelayMs: 0,
    slashCommands: [],
    slashCommandDelayMs: 350,
  })
    .then(({ data }) => {
      clearPendingSession(tempId);
      const session = data?.session;
      if (!session) {
        return;
      }

      setSession(session);
      newlyCreatedSessions.add(session.id);
      setSessionLensAvailability(session.id, true);
      selectSession(session.id);
      requestAnimationFrame(() => {
        switchTab(session.id, 'agent');
      });
      attachBookmarkToSession(session.id, sourceSession.bookmarkId ?? null, null);
    })
    .catch((e: unknown) => {
      clearPendingSession(tempId);
      log.error(() => `Failed to resume provider conversation from Command Bay: ${String(e)}`);
      showSessionLaunchFailure(e);
    });
}

function buildLensHistoryDedupeKey(profile: 'codex' | 'claude', workingDirectory: string): string {
  const normalizedPath = workingDirectory
    .replace(/\\/g, '/')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  return `lens|${profile}|${normalizedPath}`;
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
  const activeSession = activeSessionId ? getSession(activeSessionId) : null;
  const agentSurfaceSession = resolveSessionSurfaceMode(activeSession) === 'agent';
  const agentVisible =
    activeSessionId !== null && agentSurfaceSession && isTabAvailable(activeSessionId, 'agent');
  const strip = document.getElementById('mobile-tab-strip');
  const topbar = document.getElementById('mobile-topbar');
  const title = document.getElementById('mobile-title');

  const syncButton = (
    elementId: string,
    options: {
      active: boolean;
      hidden?: boolean;
      label?: string;
    },
  ): void => {
    const button = document.getElementById(elementId) as HTMLButtonElement | null;
    if (!button) {
      return;
    }

    button.classList.toggle('active', options.active);
    if (typeof options.hidden === 'boolean') {
      button.toggleAttribute('hidden', options.hidden);
    }

    if (typeof options.label === 'string') {
      button.title = options.label;
      button.setAttribute('aria-label', options.label);
      const labelNode = button.querySelector<HTMLElement>('.mobile-actions-label, span');
      if (labelNode) {
        labelNode.textContent = options.label;
      }
    }
  };

  const terminalLabel = activeSessionId
    ? getTabLabelForSession(activeSessionId, 'terminal')
    : t('session.terminal');
  const agentLabel = activeSession ? getAgentSurfaceLabel(activeSession) : t('sessionTabs.agent');

  strip?.toggleAttribute('hidden', !activeSessionId);
  title?.toggleAttribute('hidden', Boolean(activeSessionId));
  topbar?.classList.toggle('has-mobile-tabs', Boolean(activeSessionId));
  syncButton('btn-mobile-tab-terminal', {
    active: activeTab === 'terminal',
    hidden: activeSessionId ? !isTabAvailable(activeSessionId, 'terminal') : true,
    label: terminalLabel,
  });
  syncButton('btn-mobile-tab-agent', {
    active: activeTab === 'agent',
    hidden: !agentVisible,
    label: agentLabel,
  });
  syncButton('btn-mobile-tab-files', {
    active: activeTab === 'files',
    label: t('sessionTabs.files'),
  });
  syncButton('btn-mobile-strip-terminal', {
    active: activeTab === 'terminal',
    hidden: activeSessionId ? !isTabAvailable(activeSessionId, 'terminal') : true,
    label: terminalLabel,
  });
  syncButton('btn-mobile-strip-agent', {
    active: activeTab === 'agent',
    hidden: !agentVisible,
    label: agentLabel,
  });
  syncButton('btn-mobile-strip-files', {
    active: activeTab === 'files',
    label: t('sessionTabs.files'),
  });
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
    if (activeId) void enableMidtermFeatures(activeId);
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

  bindClick('update-btn', handlePrimaryUpdateAction);
  bindClick('btn-check-updates', checkForUpdates);
  bindClick('btn-apply-update', handlePrimaryUpdateAction);
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
