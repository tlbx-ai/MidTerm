/**
 * Type Definitions
 *
 * Shared interfaces and types used across all modules.
 * This file defines the contract between the server and client.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

// =============================================================================
// Session Types
// =============================================================================

/** Session data from server */
export interface Session {
  id: string;
  name: string | null;
  terminalTitle: string | null;
  shellType: string;
  cols: number;
  rows: number;
  manuallyNamed?: boolean;
}

/** Terminal state for a session */
export interface TerminalState {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  serverCols: number;
  serverRows: number;
  opened: boolean;
  contextMenuHandler?: (e: MouseEvent) => void;
  pasteHandler?: (e: ClipboardEvent) => void;
}

// =============================================================================
// Settings Types
// =============================================================================

/** Theme names */
export type ThemeName = 'dark' | 'light' | 'solarizedDark' | 'solarizedLight';

/** Cursor style options */
export type CursorStyle = 'bar' | 'block' | 'underline';

/** Bell style options */
export type BellStyle = 'notification' | 'sound' | 'visual' | 'both' | 'off';

/** Clipboard shortcut options */
export type ClipboardShortcuts = 'auto' | 'windows' | 'unix';

/** Log level options (matching backend enum) */
export type LogLevelSetting = 'exception' | 'error' | 'warn' | 'info' | 'verbose';

/** User settings from server */
export interface Settings {
  defaultShell: string;
  defaultCols: number;
  defaultRows: number;
  defaultWorkingDirectory: string;
  fontSize: number;
  fontFamily: string;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  theme: ThemeName;
  minimumContrastRatio: number;
  smoothScrolling: boolean;
  useWebGL: boolean;
  scrollbackLines: number;
  bellStyle: BellStyle;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  clipboardShortcuts: ClipboardShortcuts;
  runAsUser: string | null;
  logLevel: LogLevelSetting;
}

// =============================================================================
// Authentication Types
// =============================================================================

/** Auth status from server */
export interface AuthStatus {
  authenticationEnabled: boolean;
  passwordSet: boolean;
}

// =============================================================================
// Update Types
// =============================================================================

/** Local update info (dev environment only) */
export interface LocalUpdateInfo {
  available: boolean;
  version: string;
  path: string;
  type: 'None' | 'WebOnly' | 'Full';
  sessionsPreserved: boolean;
}

/** Update info from server */
export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  downloadUrl?: string;
  assetName?: string;
  releaseNotes?: string;
  type: 'None' | 'WebOnly' | 'Full';
  sessionsPreserved: boolean;
  environment?: string;
  localUpdate?: LocalUpdateInfo;
}

// =============================================================================
// Health/Status Types
// =============================================================================

/** Health check response */
export interface HealthResponse {
  status: string;
  memoryMB: number;
  uptime: string;
  sessionCount: number;
  ttyHostVersion?: string;
  webVersion?: string;
  versionMismatch?: boolean;
  windowsBuildNumber?: number;
  healthy?: boolean;
  uptimeSeconds?: number;
  mode?: string;
  platform?: string;
  webProcessId?: number;
  ttyHostCompatible?: boolean;
  ttyHostExpected?: string;
}

/** Network interface info */
export interface NetworkInterface {
  name: string;
  ip: string;
}

/** User info for dropdown */
export interface UserInfo {
  username: string;
  displayName: string;
}

// =============================================================================
// Terminal Theme Types
// =============================================================================

/** xterm.js theme colors */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

// =============================================================================
// Application State
// =============================================================================

/** UI state */
export interface UIState {
  settingsOpen: boolean;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
}

/** Full application state */
export interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  settings: Settings | null;
  ui: UIState;
  update: UpdateInfo | null;
  auth: AuthStatus | null;
}

// =============================================================================
// DOM Element Cache
// =============================================================================

/** Cached DOM elements */
export interface DOMElements {
  sessionList: HTMLElement | null;
  sessionCount: HTMLElement | null;
  terminalsArea: HTMLElement | null;
  emptyState: HTMLElement | null;
  mobileTitle: HTMLElement | null;
  topbarActions: HTMLElement | null;
  app: HTMLElement | null;
  sidebarOverlay: HTMLElement | null;
  settingsView: HTMLElement | null;
  settingsBtn: HTMLElement | null;
  titleBarCustom: HTMLElement | null;
  titleBarTerminal: HTMLElement | null;
  titleBarSeparator: HTMLElement | null;
}
