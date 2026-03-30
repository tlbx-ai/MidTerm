/**
 * State Channel Module
 *
 * Manages the state WebSocket connection for real-time session list updates.
 * Handles automatic reconnection on disconnect.
 * Also provides bidirectional command channel for session CRUD operations.
 */

import type {
  DockPosition,
  Session,
  UpdateInfo,
  WsCommand,
  WsCommandAction,
  WsCommandPayload,
  WsCommandResponse,
} from '../../types';
import { ReconnectController, createWsUrl, closeWebSocket } from '../../utils';
import { createLogger } from '../logging';
import { initializeFromSession } from '../process';
import { destroyTerminalForSession, createTerminalForSession } from '../terminal/manager';
import { applyTerminalScaling } from '../terminal/scaling';
import { handleSessionClosed } from '../layout';
import { updateEmptyState, updateMobileTitle } from '../sidebar/sessionList';
import { renderUpdatePanel } from '../updating/checker';
import { getRememberedActiveSessionId } from '../updating/appShellState';
import { handleHiddenSessionClosed } from '../commands/commandsPanel';
import { closeOverlay } from '../commands/outputPanel';
import {
  detachPreview,
  dockBack,
  isDetachedOpenForSession,
  setDetachedPreviewViewport,
} from '../web/webDetach';
import { setViewportSize, openWebPreviewDock } from '../web/webDock';
import { setWebPreviewTarget } from '../web/webApi';
import {
  getSessionPreview,
  getSessionSelectedPreviewName,
  setSessionMode,
  setSessionSelectedPreviewName,
  upsertSessionPreview,
} from '../web/webSessionState';
import { syncActiveWebPreview } from '../web';
import { isEmbeddedWebPreviewContext } from '../web/webContext';
import { isSharedSessionRoute } from '../share';
import { checkVersionAndReload } from '../../utils/versionCheck';

interface TmuxDockMessage {
  type: 'tmux-dock';
  newSessionId: string;
  relativeToSessionId: string;
  position: string;
}

interface TmuxFocusMessage {
  type: 'tmux-focus';
  sessionId: string;
}

interface TmuxSwapMessage {
  type: 'tmux-swap';
  sessionIdA: string;
  sessionIdB: string;
}

interface MainBrowserStatusMessage {
  type: 'main-browser-status';
  isMain: boolean;
  showButton: boolean;
}

interface BrowserUiMessage {
  type: 'browser-ui';
  command: string;
  width?: number;
  height?: number;
  url?: string;
  sessionId?: string;
  previewName?: string;
  activateSession?: boolean;
}

interface StateUpdateMessage {
  type?: undefined;
  sessions?: { sessions: Session[] };
  update: UpdateInfo | null;
}

interface CommandResponseMessage {
  type: 'response';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type StateWsMessage =
  | TmuxDockMessage
  | TmuxFocusMessage
  | TmuxSwapMessage
  | MainBrowserStatusMessage
  | BrowserUiMessage
  | StateUpdateMessage
  | CommandResponseMessage;

const log = createLogger('state');
const stateReconnect = new ReconnectController();
import {
  stateWs,
  sessionTerminals,
  newlyCreatedSessions,
  hiddenSessionIds,
  setStateWs,
} from '../../state';

const COMMAND_TIMEOUT_MS = 30000;
const pendingCommands = new Map<
  string,
  {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    timeout: number;
  }
>();
import {
  $settingsOpen,
  $stateWsConnected,
  $activeSessionId,
  $sessionList,
  $updateInfo,
  $isMainBrowser,
  $showMainBrowserButton,
  $webPreviewUrl,
  setSessions,
  getParentSessionId,
} from '../../stores';
import {
  restoreLayoutFromStorage,
  dockSession,
  isSessionInLayout,
  swapLayoutSessions,
} from '../layout/layoutStore';

// Track if we've restored layout from storage (only do once on first session list)
let layoutRestoredFromStorage = false;
let stateWsHasConnected = false;

// Pending dock instructions for sessions that haven't appeared in state yet
interface PendingDock {
  targetSessionId: string;
  newSessionId: string;
  position: string;
}
const pendingDocks: PendingDock[] = [];

let selectSession: (
  sessionId: string,
  options?: { closeSettingsPanel?: boolean },
) => void = () => {};

export function setSelectSessionCallback(
  cb: (sessionId: string, options?: { closeSettingsPanel?: boolean }) => void,
): void {
  selectSession = cb;
}

/**
 * Connect to the state WebSocket for real-time session updates.
 * Automatically reconnects with exponential backoff on disconnect.
 */
export function connectStateWebSocket(): void {
  closeWebSocket(stateWs, setStateWs);

  const wsPath = isSharedSessionRoute() ? '/ws/share/state' : '/ws/state';
  const ws = new WebSocket(createWsUrl(wsPath));
  setStateWs(ws);

  ws.onopen = () => {
    stateReconnect.reset();
    const isReconnect = stateWsHasConnected;
    stateWsHasConnected = true;
    $stateWsConnected.set(true);
    reportBrowserActivity(getCurrentBrowserActivity(), true);
    if (isReconnect) {
      void checkVersionAndReload();
    }
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string) as StateWsMessage;

      // Handle command responses
      if (data.type === 'response') {
        handleCommandResponse(data);
        return;
      }

      // Handle tmux dock instructions
      if (data.type === 'tmux-dock') {
        log.verbose(
          () =>
            `Tmux dock: ${data.newSessionId} relative to ${data.relativeToSessionId} at ${data.position}`,
        );
        // Queue if the new session hasn't appeared in state yet
        if (!sessionTerminals.has(data.newSessionId)) {
          pendingDocks.push({
            targetSessionId: data.relativeToSessionId,
            newSessionId: data.newSessionId,
            position: data.position,
          });
          return;
        }
        dockSession(
          data.relativeToSessionId,
          data.newSessionId,
          data.position as DockPosition,
          true,
        );
        return;
      }

      // Handle tmux focus instructions
      if (data.type === 'tmux-focus') {
        log.verbose(() => `Tmux focus: ${data.sessionId}`);
        // Only focus if the target is related to the active session
        // (same tmux parent chain) or both are in the active layout group.
        const activeId = $activeSessionId.get();
        const activeParent = activeId ? getParentSessionId(activeId) : null;
        const focusParent = getParentSessionId(data.sessionId);
        const activeInLayout = activeId ? isSessionInLayout(activeId) : false;
        const focusInLayout = isSessionInLayout(data.sessionId);
        const sameLayoutGroup = activeInLayout && focusInLayout;
        const isRelated =
          !activeId ||
          activeId === data.sessionId ||
          activeId === focusParent ||
          activeParent === data.sessionId ||
          (activeParent !== null && activeParent === focusParent) ||
          sameLayoutGroup;
        if (isRelated) {
          if (focusInLayout) {
            // Route through main select path to apply heat suppression and mux hinting.
            selectSession(data.sessionId, { closeSettingsPanel: false });
          }
        }
        return;
      }

      // Handle tmux swap instructions
      if (data.type === 'tmux-swap') {
        log.verbose(() => `Tmux swap: ${data.sessionIdA} <-> ${data.sessionIdB}`);
        swapLayoutSessions(data.sessionIdA, data.sessionIdB);
        return;
      }

      // Handle main browser status (server-driven)
      if (data.type === 'main-browser-status') {
        $isMainBrowser.set(data.isMain);
        $showMainBrowserButton.set(data.showButton);
        return;
      }

      // Handle browser UI commands (detach/dock/viewport from mtcli)
      if (data.type === 'browser-ui') {
        handleBrowserUiCommand(data);
        return;
      }

      // Handle state updates
      const sessionList = data.sessions?.sessions ?? [];
      handleStateUpdate(sessionList);
      handleUpdateInfo(data.update);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(() => `Error parsing state: ${message}`);
    }
  };

  ws.onclose = () => {
    $stateWsConnected.set(false);

    // Reject all pending commands immediately (don't wait for timeout)
    pendingCommands.forEach((cmd, id) => {
      clearTimeout(cmd.timeout);
      cmd.reject(new Error('Connection lost'));
      pendingCommands.delete(id);
    });

    scheduleStateReconnect();
  };

  ws.onerror = (e) => {
    log.error(() => `WebSocket error: ${e.type}`);
  };
}

/**
 * Handle session list updates from server.
 * Removes terminals for deleted sessions, updates dimensions, and manages selection.
 * Creates terminals proactively for all sessions so they receive data in the background.
 */
export function handleStateUpdate(newSessions: Session[]): void {
  // Filter out sessions without required id field
  const validSessions = newSessions.filter((s): s is Session & { id: string } => !!s.id);

  // Remove terminals for deleted sessions (skip hidden command overlay sessions)
  const newIds = new Set(validSessions.map((s) => s.id));
  sessionTerminals.forEach((_, id) => {
    if (!newIds.has(id) && !hiddenSessionIds.has(id)) {
      handleSessionClosed(id);
      destroyTerminalForSession(id);
      newlyCreatedSessions.delete(id);
    }
  });

  // Clean up hidden sessions that no longer exist on the server (script finished)
  for (const hiddenId of hiddenSessionIds) {
    if (!newIds.has(hiddenId)) {
      handleHiddenSessionClosed(hiddenId);
      closeOverlay(hiddenId);
    }
  }

  // Update dimensions and resize terminals when server dimensions change
  // Also create terminals proactively for sessions that don't have one yet
  // Initialize process state from session data (for reconnect scenarios)
  validSessions.forEach((session) => {
    // Initialize process monitor state from session data
    initializeFromSession(
      session.id,
      session.foregroundPid,
      session.foregroundName,
      session.foregroundCommandLine,
      session.currentDirectory,
      session.foregroundDisplayName,
      session.foregroundProcessIdentity,
    );

    const state = sessionTerminals.get(session.id);
    if (state && state.opened) {
      const dimensionsChanged =
        state.serverCols !== session.cols || state.serverRows !== session.rows;
      if (dimensionsChanged) {
        state.serverCols = session.cols;
        state.serverRows = session.rows;
        state.terminal.resize(session.cols, session.rows);
        applyTerminalScaling(session.id, state);
      }
    } else if (state) {
      state.serverCols = session.cols;
      state.serverRows = session.rows;
    } else if (session.lensOnly) {
      return;
    } else {
      // Create terminal proactively - it will be hidden and ready for data
      createTerminalForSession(session.id, session);
    }
  });

  // Update store - sidebarUpdater subscription handles rendering
  setSessions(validSessions);
  updateEmptyState();

  // Apply any queued dock instructions now that sessions exist
  for (let i = pendingDocks.length - 1; i >= 0; i--) {
    const dock = pendingDocks[i];
    if (!dock) continue;
    if (sessionTerminals.has(dock.newSessionId)) {
      pendingDocks.splice(i, 1);
      dockSession(dock.targetSessionId, dock.newSessionId, dock.position as DockPosition, true);
    }
  }

  // Restore layout from localStorage on first session list (after page load)
  if (!layoutRestoredFromStorage && newSessions.length >= 2) {
    layoutRestoredFromStorage = true;
    restoreLayoutFromStorage();
  }

  // Auto-select first session if none active (but not if settings are open)
  const isSettingsOpen = $settingsOpen.get();
  const activeId = $activeSessionId.get();
  const sessionList = $sessionList.get();
  const firstSession = sessionList[0];
  if (!activeId && firstSession?.id && !isSettingsOpen) {
    const rememberedActiveId = getRememberedActiveSessionId();
    const rememberedSession =
      rememberedActiveId !== null
        ? sessionList.find((session) => session.id === rememberedActiveId)
        : undefined;
    selectSession((rememberedSession ?? firstSession).id, { closeSettingsPanel: false });
  }

  // Handle active session being deleted (but not if settings are open)
  if (activeId && !sessionList.find((s) => s.id === activeId)) {
    $activeSessionId.set(null);
    const nextSession = sessionList[0];
    if (nextSession?.id && !isSettingsOpen) {
      selectSession(nextSession.id, { closeSettingsPanel: false });
    }
  }

  updateMobileTitle();
}

/**
 * Handle update info from server.
 * Updates the stored update info and renders the update panel.
 */
export function handleUpdateInfo(update: UpdateInfo | null): void {
  $updateInfo.set(update);
  renderUpdatePanel();
}

/**
 * Schedule state WebSocket reconnection.
 */
export function scheduleStateReconnect(): void {
  stateReconnect.schedule(connectStateWebSocket);
}

// =============================================================================
// WebSocket Command API
// =============================================================================

/**
 * Handle command response from server.
 */
function handleCommandResponse(response: WsCommandResponse): void {
  const pending = pendingCommands.get(response.id);
  if (!pending) {
    log.verbose(() => `Received response for unknown command: ${response.id}`);
    return;
  }

  clearTimeout(pending.timeout);
  pendingCommands.delete(response.id);

  if (response.success) {
    pending.resolve(response.data);
  } else {
    pending.reject(new Error(response.error ?? 'Command failed'));
  }
}

/**
 * Send a command to the server over the state WebSocket.
 * Returns a promise that resolves with the response data or rejects on error.
 */
export function sendCommand<T = unknown>(
  action: 'browser.claimMain' | 'browser.releaseMain',
): Promise<T>;
export function sendCommand<T = unknown>(
  action: 'browser.setActivity',
  payload: WsCommandPayload<'browser.setActivity'>,
): Promise<T>;
export function sendCommand<T = unknown>(
  action: 'session.rename',
  payload: WsCommandPayload<'session.rename'>,
): Promise<T>;
export function sendCommand<T = unknown>(
  action: 'session.reorder',
  payload: WsCommandPayload<'session.reorder'>,
): Promise<T>;
export async function sendCommand<T = unknown>(
  action: WsCommandAction,
  payload?:
    | WsCommandPayload<'session.rename'>
    | WsCommandPayload<'session.reorder'>
    | WsCommandPayload<'browser.setActivity'>,
): Promise<T> {
  const ws = stateWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket not connected');
  }

  const id = crypto.randomUUID();
  let command: WsCommand;
  switch (action) {
    case 'browser.claimMain':
    case 'browser.releaseMain':
      command = {
        type: 'command',
        id,
        action,
      };
      break;
    case 'browser.setActivity':
      command = {
        type: 'command',
        id,
        action,
        payload: payload as WsCommandPayload<'browser.setActivity'>,
      };
      break;
    case 'session.rename':
      command = {
        type: 'command',
        id,
        action,
        payload: payload as WsCommandPayload<'session.rename'>,
      };
      break;
    case 'session.reorder':
      command = {
        type: 'command',
        id,
        action,
        payload: payload as WsCommandPayload<'session.reorder'>,
      };
      break;
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`Command timed out: ${action}`));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(id, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timeout,
    });

    try {
      ws.send(JSON.stringify(command));
    } catch (e) {
      clearTimeout(timeout);
      pendingCommands.delete(id);
      reject(new Error(e instanceof Error ? e.message : String(e)));
    }
  });
}

/**
 * Handle browser UI commands from the server (detach, dock, viewport).
 */
function handleBrowserUiCommand(msg: BrowserUiMessage): void {
  if (isEmbeddedWebPreviewContext()) {
    log.verbose(() => `Ignoring browser-ui command inside embedded preview: ${msg.command}`);
    return;
  }

  void checkVersionAndReload();

  switch (msg.command) {
    case 'detach': {
      const target = resolveBrowserUiTarget(msg);
      if (!target) {
        break;
      }
      setSessionMode(target.sessionId, target.previewName, 'detached');
      void detachPreview(target.sessionId, target.previewName);
      break;
    }
    case 'dock': {
      const target = resolveBrowserUiTarget(msg);
      if (!target) {
        break;
      }
      setSessionMode(target.sessionId, target.previewName, 'docked');
      dockBack(target.sessionId, target.previewName);
      if ($activeSessionId.get() === target.sessionId) {
        void syncActiveWebPreview();
      }
      break;
    }
    case 'viewport': {
      const target = resolveBrowserUiTarget(msg);
      if (!target) {
        break;
      }
      const preview = getSessionPreview(target.sessionId, target.previewName);
      if (
        preview?.mode === 'detached' &&
        isDetachedOpenForSession(target.sessionId, target.previewName) &&
        setDetachedPreviewViewport(
          target.sessionId,
          target.previewName,
          msg.width ?? 0,
          msg.height ?? 0,
        )
      ) {
        break;
      }

      setSessionMode(target.sessionId, target.previewName, 'docked');
      if ($activeSessionId.get() === target.sessionId) {
        openWebPreviewDock();
        void syncActiveWebPreview().finally(() => {
          setViewportSize(msg.width ?? 0, msg.height ?? 0);
        });
      }
      break;
    }
    case 'open': {
      const target = resolveBrowserUiTarget(msg);
      if (!target || !msg.url) {
        break;
      }
      setSessionMode(target.sessionId, target.previewName, 'docked');
      if (msg.url) {
        void handleBrowserOpen(
          target.sessionId,
          target.previewName,
          msg.url,
          msg.activateSession === true,
        );
      }
      break;
    }
    default:
      log.warn(() => `Unknown browser-ui command: ${msg.command}`);
  }
}

function resolveBrowserUiTarget(
  msg: BrowserUiMessage,
): { sessionId: string; previewName: string } | null {
  const sessionId = msg.sessionId ?? $activeSessionId.get();
  if (!sessionId) {
    return null;
  }

  const previewName = setSessionSelectedPreviewName(
    sessionId,
    msg.previewName ?? getSessionSelectedPreviewName(sessionId),
  );

  return { sessionId, previewName };
}

async function handleBrowserOpen(
  sessionId: string,
  previewName: string,
  url: string,
  activateSession = false,
): Promise<void> {
  const result = await setWebPreviewTarget(sessionId, previewName, url);
  if (!result?.active) {
    return;
  }

  upsertSessionPreview(result);
  setSessionSelectedPreviewName(sessionId, previewName);
  setSessionMode(sessionId, previewName, 'docked');
  if (activateSession && $activeSessionId.get() !== sessionId) {
    selectSession(sessionId, { closeSettingsPanel: false });
  }
  if ($activeSessionId.get() !== sessionId) {
    return;
  }
  $webPreviewUrl.set(url);
  openWebPreviewDock();
  await syncActiveWebPreview();
}

/**
 * Check if the state WebSocket is connected and ready for commands.
 */
export function isStateConnected(): boolean {
  return stateWs !== null && stateWs.readyState === WebSocket.OPEN;
}

/**
 * Persist session order to server.
 * Fire-and-forget - failures are logged but not thrown.
 */
export function persistSessionOrder(sessionIds: string[]): void {
  if (!isStateConnected()) return;

  sendCommand('session.reorder', { sessionIds }).catch((e: unknown) => {
    log.warn(() => `Failed to persist session order: ${String(e)}`);
  });
}

/**
 * Claim main browser status from server.
 * Fire-and-forget - server will push status to all connections.
 */
export function claimMainBrowser(): void {
  if (!isStateConnected()) return;
  sendCommand('browser.claimMain').catch((e: unknown) => {
    log.warn(() => `Failed to claim main browser: ${String(e)}`);
  });
}

function getCurrentBrowserActivity(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }

  const visible = document.visibilityState === 'visible' && !document.hidden;
  const focused = typeof document.hasFocus !== 'function' || document.hasFocus();
  return visible && focused;
}

let lastReportedBrowserActivity: boolean | undefined;

export function reportBrowserActivity(
  isActive: boolean = getCurrentBrowserActivity(),
  force: boolean = false,
): void {
  if (isSharedSessionRoute() || !isStateConnected()) return;
  if (!force && lastReportedBrowserActivity === isActive) return;

  sendCommand('browser.setActivity', { isActive })
    .then(() => {
      lastReportedBrowserActivity = isActive;
    })
    .catch((e: unknown) => {
      log.warn(() => `Failed to report browser activity: ${String(e)}`);
    });
}

/**
 * Release main browser status to server.
 * Fire-and-forget - server will push status to all connections.
 */
export function releaseMainBrowser(): void {
  if (!isStateConnected()) return;
  sendCommand('browser.releaseMain').catch((e: unknown) => {
    log.warn(() => `Failed to release main browser: ${String(e)}`);
  });
}
