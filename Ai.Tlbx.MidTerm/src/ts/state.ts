/**
 * Application State
 *
 * Centralized state management for the application.
 * Replaces the global variables from the original JavaScript.
 */

import type {
  Session,
  TerminalState,
  Settings,
  UpdateInfo,
  AuthStatus,
  DOMElements
} from './types';

// =============================================================================
// State Store
// =============================================================================

/** Sessions from server */
export let sessions: Session[] = [];

/** Currently active session ID */
export let activeSessionId: string | null = null;

/** User settings from server */
export let currentSettings: Settings | null = null;

/** Update info from server */
export let updateInfo: UpdateInfo | null = null;

/** Auth status from server */
export let authStatus: AuthStatus | null = null;

// =============================================================================
// UI State
// =============================================================================

/** Settings panel visibility */
export let settingsOpen = false;

/** Mobile sidebar visibility */
export let sidebarOpen = false;

/** Desktop sidebar collapsed state */
export let sidebarCollapsed = false;

// =============================================================================
// WebSocket State
// =============================================================================

/** State WebSocket connection */
export let stateWs: WebSocket | null = null;

/** State WebSocket reconnect timer */
export let stateReconnectTimer: number | undefined;

/** State WebSocket reconnect delay */
export let stateReconnectDelay = 1000;

/** State WebSocket connected flag */
export let stateWsConnected = false;

/** Mux WebSocket connection */
export let muxWs: WebSocket | null = null;

/** Mux WebSocket reconnect timer */
export let muxReconnectTimer: number | undefined;

/** Mux WebSocket reconnect delay */
export let muxReconnectDelay = 1000;

/** Mux WebSocket connected flag */
export let muxWsConnected = false;

/** Tracks if mux WebSocket has ever connected (for reconnect detection) */
export let muxHasConnected = false;

// =============================================================================
// Terminal State
// =============================================================================

/** Windows build number for ConPTY configuration (null on non-Windows) */
export let windowsBuildNumber: number | null = null;

/** Per-session terminal state */
export const sessionTerminals = new Map<string, TerminalState>();

/** Sessions created in this browser session (use WebSocket buffering) */
export const newlyCreatedSessions = new Set<string>();

/** Pending sessions being created (for optimistic UI) */
export const pendingSessions = new Set<string>();

/** Buffer WebSocket output frames for terminals not yet opened */
export const pendingOutputFrames = new Map<string, Uint8Array[]>();

/** Font loading promise */
export let fontsReadyPromise: Promise<void> | null = null;

// =============================================================================
// DOM Element Cache
// =============================================================================

/** Cached DOM elements */
export const dom: DOMElements = {
  sessionList: null,
  sessionCount: null,
  terminalsArea: null,
  emptyState: null,
  mobileTitle: null,
  topbarActions: null,
  app: null,
  sidebarOverlay: null,
  settingsView: null,
  settingsBtn: null,
  islandTitle: null
};

// =============================================================================
// State Setters
// =============================================================================

export function setSessions(newSessions: Session[]): void {
  sessions = newSessions;
}

export function setActiveSessionId(id: string | null): void {
  activeSessionId = id;
}

export function setCurrentSettings(settings: Settings | null): void {
  currentSettings = settings;
}

export function setUpdateInfo(info: UpdateInfo | null): void {
  updateInfo = info;
}

export function setAuthStatus(status: AuthStatus | null): void {
  authStatus = status;
}

export function setSettingsOpen(open: boolean): void {
  settingsOpen = open;
}

export function setSidebarOpen(open: boolean): void {
  sidebarOpen = open;
}

export function setSidebarCollapsed(collapsed: boolean): void {
  sidebarCollapsed = collapsed;
}

export function setStateWs(ws: WebSocket | null): void {
  stateWs = ws;
}

export function setStateReconnectTimer(timer: number | undefined): void {
  stateReconnectTimer = timer;
}

export function setStateReconnectDelay(delay: number): void {
  stateReconnectDelay = delay;
}

export function setStateWsConnected(connected: boolean): void {
  stateWsConnected = connected;
}

export function setMuxWs(ws: WebSocket | null): void {
  muxWs = ws;
}

export function setMuxReconnectTimer(timer: number | undefined): void {
  muxReconnectTimer = timer;
}

export function setMuxReconnectDelay(delay: number): void {
  muxReconnectDelay = delay;
}

export function setMuxWsConnected(connected: boolean): void {
  muxWsConnected = connected;
}

export function setMuxHasConnected(connected: boolean): void {
  muxHasConnected = connected;
}

export function setFontsReadyPromise(promise: Promise<void>): void {
  fontsReadyPromise = promise;
}

export function setWindowsBuildNumber(build: number | null): void {
  windowsBuildNumber = build;
}

// =============================================================================
// DOM Element Cache Initialization
// =============================================================================

/**
 * Cache DOM elements for quick access
 */
export function cacheDOMElements(): void {
  dom.sessionList = document.getElementById('session-list');
  dom.sessionCount = document.getElementById('session-count');
  dom.terminalsArea = document.querySelector('.terminals-area');
  dom.emptyState = document.getElementById('empty-state');
  dom.mobileTitle = document.getElementById('mobile-title');
  dom.topbarActions = document.getElementById('topbar-actions');
  dom.app = document.getElementById('app');
  dom.sidebarOverlay = document.getElementById('sidebar-overlay');
  dom.settingsView = document.getElementById('settings-view');
  dom.settingsBtn = document.getElementById('btn-settings');
  dom.islandTitle = document.getElementById('island-title');
}
