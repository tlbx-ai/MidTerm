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
  currentDirectory?: string;
  foregroundPid?: number;
  foregroundName?: string;
  foregroundCommandLine?: string;
  /** Server-side ordering index (persists across reconnects) */
  order?: number;
  /** Client-side ordering index (used for local sorting) */
  _order?: number;
}

// =============================================================================
// Process Monitoring Types
// =============================================================================

/** Process event type */
export type ProcessEventType = 'Fork' | 'Exec' | 'Exit';

/** Process lifecycle event from server */
export interface ProcessEventPayload {
  Type: ProcessEventType;
  Pid: number;
  ParentPid: number;
  Name: string | null;
  CommandLine: string | null;
  ExitCode: number | null;
  Timestamp: string;
}

/** Foreground process change from server */
export interface ForegroundChangePayload {
  Pid: number;
  Name: string;
  CommandLine: string | null;
  Cwd: string | null;
}

/** Process state for a session */
export interface ProcessState {
  foregroundPid: number | null;
  foregroundName: string | null;
  foregroundCommandLine: string | null;
  foregroundCwd: string | null;
  recentProcesses: RacingLogEntry[];
  showRacingLog: boolean;
}

/** Entry in the racing subprocess log */
export interface RacingLogEntry {
  pid: number;
  name: string;
  commandLine: string | null;
  timestamp: number;
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

/** Health check response (legacy, use BootstrapResponse for new code) */
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

/** Shell info from server */
export interface ShellInfo {
  type: string;
  displayName: string;
  isAvailable: boolean;
  supportsOsc7: boolean;
}

/** Certificate info */
export interface CertificateInfo {
  fingerprint?: string;
  notBefore?: string;
  notAfter?: string;
  isFallbackCertificate?: boolean;
}

/** Update result from previous update */
export interface UpdateResult {
  found: boolean;
  success: boolean;
  message: string;
  details: string;
  timestamp: string;
  logFile: string;
}

/** Consolidated startup data from GET /api/bootstrap */
export interface BootstrapResponse {
  auth: AuthStatus;
  version: string;
  ttyHostVersion?: string;
  ttyHostCompatible: boolean;
  uptimeSeconds: number;
  platform: string;
  settings: Settings;
  networks: NetworkInterface[];
  users: UserInfo[];
  shells: ShellInfo[];
  updateResult?: UpdateResult;
  devMode: boolean;
}

/** Minimal startup data for login page from GET /api/bootstrap/login */
export interface BootstrapLoginResponse {
  certificate?: CertificateInfo;
}

// =============================================================================
// WebSocket Command Types
// =============================================================================

/** WebSocket command from client to server */
export interface WsCommand {
  type: 'command';
  id: string;
  action: string;
  payload?: WsCommandPayload | undefined;
}

/** Payload for WebSocket commands */
export interface WsCommandPayload {
  // session.create
  cols?: number;
  rows?: number;
  shell?: string;
  workingDirectory?: string;

  // session.close, session.rename
  sessionId?: string;

  // session.rename
  name?: string | null;
  auto?: boolean;

  // session.reorder
  sessionIds?: string[];

  // settings.save
  settings?: Settings;
}

/** WebSocket command response from server */
export interface WsCommandResponse {
  type: 'response';
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Data returned for session.create command */
export interface WsSessionCreatedData {
  id: string;
  pid: number;
  shellType: string;
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
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  scrollbarSliderActiveBackground: string;
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
// Voice/Chat Types
// =============================================================================

/** Chat message role */
export type ChatRole = 'user' | 'assistant' | 'tool';

/** Chat message from voice server */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolName?: string;
  timestamp: string;
}

/** Voice provider info from health endpoint */
export interface VoiceProvider {
  id: string;
  name: string;
  available: boolean;
  voices: VoiceInfo[];
}

/** Voice info within a provider */
export interface VoiceInfo {
  id: string;
  name: string;
}

/** Voice server defaults */
export interface VoiceDefaults {
  provider: string;
  voice: string;
  speed: number;
}

/** Extended voice health response */
export interface VoiceHealthResponse {
  status: string;
  version: string;
  providers?: VoiceProvider[];
  defaults?: VoiceDefaults;
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
