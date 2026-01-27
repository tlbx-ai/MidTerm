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
  hasWebgl?: boolean;
  /** xterm event disposables for cleanup */
  disposables?: Array<{ dispose: () => void }>;
  /** Mouse move handler for cursor hiding */
  mouseMoveHandler?: () => void;
  /** Mouse leave handler for cursor hiding */
  mouseLeaveHandler?: () => void;
  /** Early onData handler (registered immediately, disposed when full handlers set up) */
  earlyDataDisposable?: { dispose: () => void };
}

// =============================================================================
// Settings Types
// =============================================================================

/** Theme names */
export type ThemeName = 'dark' | 'light' | 'solarizedDark' | 'solarizedLight';

/** Cursor style options */
export type CursorStyle = 'bar' | 'block' | 'underline';

/** Cursor inactive style options (when terminal loses focus) */
export type CursorInactiveStyle = 'outline' | 'block' | 'bar' | 'underline' | 'none';

/** Bell style options */
export type BellStyle = 'notification' | 'sound' | 'visual' | 'both' | 'off';

/** Clipboard shortcut options */
export type ClipboardShortcuts = 'auto' | 'windows' | 'unix';

/** Tab title mode options */
export type TabTitleMode =
  | 'hostname'
  | 'static'
  | 'sessionName'
  | 'terminalTitle'
  | 'foregroundProcess';

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
  cursorInactiveStyle: CursorInactiveStyle;
  theme: ThemeName;
  tabTitleMode: TabTitleMode;
  minimumContrastRatio: number;
  smoothScrolling: boolean;
  useWebGL: boolean;
  scrollbackLines: number;
  bellStyle: BellStyle;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  clipboardShortcuts: ClipboardShortcuts;
  scrollbackProtection: boolean;
  fileRadar: boolean;
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

/** Feature flags for conditional UI features */
export interface FeatureFlags {
  voiceChat: boolean;
}

/** Consolidated startup data from GET /api/bootstrap */
export interface BootstrapResponse {
  auth: AuthStatus;
  version: string;
  ttyHostVersion?: string;
  ttyHostCompatible: boolean;
  uptimeSeconds: number;
  platform: string;
  hostname: string;
  settings: Settings;
  networks: NetworkInterface[];
  users: UserInfo[];
  shells: ShellInfo[];
  updateResult?: UpdateResult;
  devMode: boolean;
  features: FeatureFlags;
  voicePassword?: string;
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
// Voice Tool Protocol Types
// =============================================================================

/** Tool names available to voice assistant */
export type VoiceToolName =
  | 'state_of_things'
  | 'make_input'
  | 'read_scrollback'
  | 'interactive_read';

/** Tool request from voice server to browser */
export interface VoiceToolRequest {
  type: 'tool_request';
  requestId: string;
  tool: VoiceToolName;
  args: Record<string, unknown>;
  requiresConfirmation?: boolean;
}

/** Tool response from browser to voice server */
export interface VoiceToolResponse {
  type: 'tool_response';
  requestId: string;
  result: unknown;
  error?: string;
  declined?: boolean;
}

/** Args for make_input tool */
export interface MakeInputArgs {
  sessionId: string;
  text: string;
  justification?: string;
  delayMs?: number;
}

/** Args for read_scrollback tool */
export interface ReadScrollbackArgs {
  sessionId: string;
  start?: string;
  lines?: number;
}

/** Args for interactive_read tool */
export interface InteractiveReadArgs {
  sessionId: string;
  operations: InteractiveOp[];
  justification?: string;
}

/** Single operation in interactive_read */
export interface InteractiveOp {
  type: 'input' | 'delay' | 'screenshot';
  data?: string;
  delayMs?: number;
}

/** Result of state_of_things tool */
export interface StateOfThingsResult {
  sessions: VoiceSessionState[];
  activeSessionId: string | null;
  version: string;
  updateAvailable: boolean;
  recentBells: BellNotification[];
}

/** Session state for voice assistant */
export interface VoiceSessionState {
  id: string;
  userTitle: string | null;
  terminalTitle: string | null;
  foregroundName: string | null;
  foregroundCommandLine: string | null;
  currentDirectory: string | null;
  shell: string;
  cols: number;
  rows: number;
  isRunning: boolean;
  isActive: boolean;
  screenContent: string;
}

/** Bell notification for voice assistant */
export interface BellNotification {
  sessionId: string;
  timestamp: string;
}

/** Result of make_input tool */
export interface MakeInputResult {
  success: boolean;
  screenContent: string;
  cols: number;
  rows: number;
}

/** Result of read_scrollback tool */
export interface ReadScrollbackResult {
  content: string;
  totalLines: number;
  returnedLines: number;
  startLine: number;
}

/** Result of interactive_read tool */
export interface InteractiveReadResult {
  results: InteractiveOpResult[];
}

/** Single operation result */
export interface InteractiveOpResult {
  index: number;
  success: boolean;
  screenshot?: string;
}

/** Pending tool confirmation request */
export interface PendingToolConfirmation {
  requestId: string;
  tool: VoiceToolName;
  args: Record<string, unknown>;
  justification?: string;
  displayText: string;
  resolve: (approved: boolean) => void;
}

// =============================================================================
// File Viewer Types
// =============================================================================

/** File path info from server */
export interface FilePathInfo {
  exists: boolean;
  size?: number;
  isDirectory: boolean;
  mimeType?: string;
  modified?: string;
  isText?: boolean;
}

/** Response from /api/files/check */
export interface FileCheckResponse {
  results: Record<string, FilePathInfo>;
}

/** Directory entry from /api/files/list */
export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  size?: number;
  modified?: string;
  mimeType?: string;
}

/** Response from /api/files/list */
export interface DirectoryListResponse {
  path: string;
  entries: DirectoryEntry[];
}

/** Response from /api/files/resolve - lazy resolution of relative paths */
export interface FileResolveResponse {
  exists: boolean;
  resolvedPath?: string;
  isDirectory?: boolean;
  size?: number;
  mimeType?: string;
  modified?: string;
  isText?: boolean;
}

// =============================================================================
// Layout Types
// =============================================================================

/** Direction of a split layout */
export type LayoutDirection = 'horizontal' | 'vertical';

/** Position for docking a session relative to another */
export type DockPosition = 'top' | 'bottom' | 'left' | 'right';

/** A pane can be either a terminal session or a nested split */
export type LayoutNode = LayoutLeaf | LayoutSplit;

/** Leaf node - contains a terminal session */
export interface LayoutLeaf {
  type: 'leaf';
  sessionId: string;
}

/** Split node - contains children arranged in a direction */
export interface LayoutSplit {
  type: 'split';
  direction: LayoutDirection;
  children: LayoutNode[];
}

/** Root layout for the display (null = single standalone session) */
export interface DisplayLayout {
  root: LayoutNode | null;
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
