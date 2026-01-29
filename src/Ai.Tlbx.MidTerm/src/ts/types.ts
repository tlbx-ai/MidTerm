/**
 * Type Definitions
 *
 * Client-only interfaces and types used across all modules.
 * API types are imported from api/types.ts which re-exports from generated types.
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

// Import types needed for local use
import type {
  Session as SessionType,
  MidTermSettingsPublic as MidTermSettingsPublicType,
  AuthStatusResponse as AuthStatusResponseType,
  UpdateInfo as UpdateInfoType,
} from './api/types';

// Re-export API types for convenience
export type {
  Session,
  MidTermSettingsPublic,
  AuthStatusResponse,
  UpdateInfo,
  LocalUpdateInfo,
  UpdateResult,
  SystemHealth,
  ShellInfoDto,
  CertificateInfoResponse,
  BootstrapResponse,
  BootstrapLoginResponse,
  NetworkInterfaceDto,
  UserInfo,
  FeatureFlags,
  FilePathInfo,
  FileCheckResponse,
  DirectoryEntry,
  DirectoryListResponse,
  FileResolveResponse,
  ThemeSetting,
  CursorStyleSetting,
  CursorInactiveStyleSetting,
  BellStyleSetting,
  ClipboardShortcutsSetting,
  TabTitleModeSetting,
  // Backward compat aliases
  Settings,
  AuthStatus,
  HealthResponse,
  ShellInfo,
  CertificateInfo,
  NetworkInterface,
  ThemeName,
  CursorStyle,
  CursorInactiveStyle,
  BellStyle,
  ClipboardShortcuts,
  TabTitleMode,
} from './api/types';

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
  disposables?: Array<{ dispose: () => void }>;
  mouseMoveHandler?: () => void;
  mouseLeaveHandler?: () => void;
  earlyDataDisposable?: { dispose: () => void };
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
  cols?: number;
  rows?: number;
  shell?: string;
  workingDirectory?: string;
  sessionId?: string;
  name?: string | null;
  auto?: boolean;
  sessionIds?: string[];
  settings?: MidTermSettingsPublicType;
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
  sessions: SessionType[];
  activeSessionId: string | null;
  settings: MidTermSettingsPublicType | null;
  ui: UIState;
  update: UpdateInfoType | null;
  auth: AuthStatusResponseType | null;
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
