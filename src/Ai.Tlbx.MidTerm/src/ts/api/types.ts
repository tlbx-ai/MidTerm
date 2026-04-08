/**
 * API Types Module
 *
 * Central import point for all API types. Re-exports generated types from
 * api.generated.ts and defines client-extended types.
 *
 * IMPORTANT: This is the ONLY place API types should be imported from.
 * Never import directly from api.generated.ts in application code.
 */

import type { components } from '../api.generated';

// =============================================================================
// Schema Types Access
// =============================================================================

export type Schemas = components['schemas'];

// =============================================================================
// API Response Types (re-exported from generated)
// =============================================================================

// Auth
export type AuthResponse = Schemas['AuthResponse'];
export type AuthStatusResponse = Schemas['AuthStatusResponse'];
export type LoginRequest = Schemas['LoginRequest'];
export type ChangePasswordRequest = Schemas['ChangePasswordRequest'];

// Bootstrap
export type BootstrapResponse = Schemas['BootstrapResponse'];
export type BootstrapLoginResponse = Schemas['BootstrapLoginResponse'];

// Sessions
export type SessionInfoDto = Schemas['SessionInfoDto'] & {
  lensOnly?: boolean;
  profileHint?: string | null;
  lensResumeThreadId?: string | null;
};
export type SessionListDto = Schemas['SessionListDto'];
export type CreateSessionRequest = Schemas['CreateSessionRequest'];
export type WorkerBootstrapRequest = Schemas['WorkerBootstrapRequest'] & {
  lensOnly?: boolean;
  resumeThreadId?: string | null;
};
export type WorkerBootstrapResponse = Schemas['WorkerBootstrapResponse'];
export interface ProviderResumeCatalogEntryDto {
  provider: string;
  sessionId: string;
  workingDirectory: string;
  title: string;
  previewText?: string | null;
  updatedAtUtc: string;
}
export type RenameSessionRequest = Schemas['RenameSessionRequest'];
export type ResizeRequest = Schemas['ResizeRequest'];
export type ResizeResponse = Schemas['ResizeResponse'];
export type SessionPromptRequest = Schemas['SessionPromptRequest'];
export type SessionStateResponse = Schemas['SessionStateResponse'];
export type AgentSessionFeedResponse = Schemas['AgentSessionFeedResponse'];
export type AgentSessionVibeChip = Schemas['AgentSessionVibeChip'];
export type AgentSessionVibeHeader = Schemas['AgentSessionVibeHeader'];
export type AgentSessionVibeLane = Schemas['AgentSessionVibeLane'];
export type AgentSessionVibeCapability = Schemas['AgentSessionVibeCapability'];
export type AgentSessionVibeOverview = Schemas['AgentSessionVibeOverview'];
export type AgentSessionVibeActivity = Schemas['AgentSessionVibeActivity'];
export type AgentSessionVibeHeatSample = Schemas['SessionActivityHeatSample'];
export type AgentSessionVibeTerminal = Schemas['AgentSessionVibeTerminal'];
export type AgentSessionVibeResponse = Schemas['AgentSessionVibeResponse'];
export interface LensAttachmentReference {
  kind: string;
  path: string;
  mimeType?: string | null;
  displayName?: string | null;
}

export interface LensCommandAcceptedResponse {
  sessionId: string;
  status: string;
  requestId?: string | null;
  turnId?: string | null;
}

export interface LensInterruptRequest {
  turnId?: string | null;
}

export interface LensPulseAnsweredQuestion {
  questionId: string;
  answers: string[];
}

export interface LensPulseContentDeltaPayload {
  streamKind: string;
  delta: string;
}

export interface LensPulseDiffUpdatedPayload {
  unifiedDiff: string;
}

export interface LensPulseEventRaw {
  source: string;
  method?: string | null;
  payloadJson?: string | null;
}

export interface LensPulseSessionStatePayload {
  state: string;
  stateLabel: string;
  reason?: string | null;
}

export interface LensPulseThreadStatePayload {
  state: string;
  stateLabel: string;
  providerThreadId?: string | null;
}

export interface LensPulseTurnStartedPayload {
  model?: string | null;
  effort?: string | null;
}

export interface LensPulseTurnCompletedPayload {
  state: string;
  stateLabel: string;
  stopReason?: string | null;
  errorMessage?: string | null;
}

export interface LensPulsePlanDeltaPayload {
  delta: string;
}

export interface LensPulsePlanCompletedPayload {
  planMarkdown: string;
}

export interface LensPulseItemPayload {
  itemType: string;
  status: string;
  title?: string | null;
  detail?: string | null;
  attachments: LensAttachmentReference[];
}

export interface LensPulseQuickSettingsPayload {
  model?: string | null;
  effort?: string | null;
  planMode: string;
  permissionMode: string;
}

export interface LensQuickSettingsSummary {
  model?: string | null;
  effort?: string | null;
  planMode: string;
  permissionMode: string;
}

export interface LensPulseRequestOpenedPayload {
  requestType: string;
  requestTypeLabel: string;
  detail?: string | null;
}

export interface LensPulseRequestResolvedPayload {
  requestType: string;
  decision?: string | null;
}

export interface LensPulseQuestionOption {
  label: string;
  description: string;
}

export interface LensPulseQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options: LensPulseQuestionOption[];
}

export interface LensPulseUserInputRequestedPayload {
  questions: LensPulseQuestion[];
}

export interface LensPulseUserInputResolvedPayload {
  answers: LensPulseAnsweredQuestion[];
}

export interface LensPulseRuntimeMessagePayload {
  message: string;
  detail?: string | null;
}

export interface LensPulseEvent {
  sequence: number;
  eventId: string;
  sessionId: string;
  provider: string;
  threadId: string;
  turnId?: string | null;
  itemId?: string | null;
  requestId?: string | null;
  createdAt: string;
  type: string;
  raw?: LensPulseEventRaw | null;
  sessionState?: LensPulseSessionStatePayload | null;
  threadState?: LensPulseThreadStatePayload | null;
  turnStarted?: LensPulseTurnStartedPayload | null;
  turnCompleted?: LensPulseTurnCompletedPayload | null;
  contentDelta?: LensPulseContentDeltaPayload | null;
  planDelta?: LensPulsePlanDeltaPayload | null;
  planCompleted?: LensPulsePlanCompletedPayload | null;
  diffUpdated?: LensPulseDiffUpdatedPayload | null;
  item?: LensPulseItemPayload | null;
  quickSettingsUpdated?: LensPulseQuickSettingsPayload | null;
  requestOpened?: LensPulseRequestOpenedPayload | null;
  requestResolved?: LensPulseRequestResolvedPayload | null;
  userInputRequested?: LensPulseUserInputRequestedPayload | null;
  userInputResolved?: LensPulseUserInputResolvedPayload | null;
  runtimeMessage?: LensPulseRuntimeMessagePayload | null;
}

export interface LensPulseEventListResponse {
  sessionId: string;
  latestSequence: number;
  events: LensPulseEvent[];
}

export interface LensPulseDeltaResponse {
  sessionId: string;
  provider: string;
  generatedAt: string;
  latestSequence: number;
  totalHistoryCount: number;
  estimatedTotalHistoryHeightPx?: number;
  session: LensPulseSessionSummary;
  thread: LensPulseThreadSummary;
  currentTurn: LensPulseTurnSummary;
  quickSettings: LensQuickSettingsSummary;
  streams: LensPulseStreamsSummary;
  historyUpserts: LensPulseHistoryEntry[];
  historyRemovals: string[];
  itemUpserts: LensPulseItemSummary[];
  itemRemovals: string[];
  requestUpserts: LensPulseRequestSummary[];
  requestRemovals: string[];
  noticeUpserts: LensPulseRuntimeNotice[];
}

export interface LensPulseSessionSummary {
  state: string;
  stateLabel: string;
  reason?: string | null;
  lastError?: string | null;
  lastEventAt?: string | null;
}

export interface LensPulseThreadSummary {
  threadId: string;
  state: string;
  stateLabel: string;
}

export interface LensPulseTurnSummary {
  turnId?: string | null;
  state: string;
  stateLabel: string;
  model?: string | null;
  effort?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface LensPulseStreamsSummary {
  assistantText: string;
  reasoningText: string;
  reasoningSummaryText: string;
  planText: string;
  commandOutput: string;
  fileChangeOutput: string;
  unifiedDiff: string;
}

export interface LensPulseHistoryEntry {
  entryId: string;
  order: number;
  estimatedHeightPx?: number;
  kind: string;
  turnId?: string | null;
  itemId?: string | null;
  requestId?: string | null;
  status: string;
  itemType?: string | null;
  title?: string | null;
  body: string;
  attachments: LensAttachmentReference[];
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
}

/** @deprecated Prefer LensPulseHistoryEntry in application code. */
export type LensPulseTranscriptEntry = LensPulseHistoryEntry;

export interface LensPulseItemSummary {
  itemId: string;
  turnId?: string | null;
  itemType: string;
  status: string;
  title?: string | null;
  detail?: string | null;
  attachments: LensAttachmentReference[];
  updatedAt: string;
}

export interface LensPulseRequestSummary {
  requestId: string;
  turnId?: string | null;
  kind: string;
  kindLabel: string;
  state: string;
  detail?: string | null;
  decision?: string | null;
  questions: LensPulseQuestion[];
  answers: LensPulseAnsweredQuestion[];
  updatedAt: string;
}

export interface LensPulseRuntimeNotice {
  eventId: string;
  type: string;
  message: string;
  detail?: string | null;
  createdAt: string;
}

export interface LensPulseSnapshotResponse {
  sessionId: string;
  provider: string;
  generatedAt: string;
  latestSequence: number;
  totalHistoryCount: number;
  estimatedTotalHistoryHeightPx?: number;
  estimatedHistoryBeforeWindowPx?: number;
  estimatedHistoryAfterWindowPx?: number;
  historyWindowStart: number;
  historyWindowEnd: number;
  hasOlderHistory: boolean;
  hasNewerHistory: boolean;
  session: LensPulseSessionSummary;
  thread: LensPulseThreadSummary;
  currentTurn: LensPulseTurnSummary;
  quickSettings: LensQuickSettingsSummary;
  streams: LensPulseStreamsSummary;
  transcript: LensPulseHistoryEntry[];
  items: LensPulseItemSummary[];
  requests: LensPulseRequestSummary[];
  notices: LensPulseRuntimeNotice[];
}

export interface LensRequestDecisionRequest {
  decision: string;
}

export interface LensTurnRequest {
  text?: string | null;
  model?: string | null;
  effort?: string | null;
  planMode?: string | null;
  permissionMode?: string | null;
  attachments: LensAttachmentReference[];
}

export interface LensTurnStartResponse {
  sessionId: string;
  provider: string;
  threadId: string;
  turnId?: string | null;
  status: string;
  quickSettings: LensQuickSettingsSummary;
}

export interface LensUserInputAnswerRequest {
  answers: LensPulseAnsweredQuestion[];
}

// Settings
export type MidTermSettingsPublic = Schemas['MidTermSettingsPublic'];
export type TerminalColorSchemeDefinition = Schemas['TerminalColorSchemeDefinition'];
export type MidTermSettingsUpdate = Omit<
  MidTermSettingsPublic,
  | 'authenticationEnabled'
  | 'backgroundImageFileName'
  | 'backgroundImageRevision'
  | 'runAsUserSid'
  | 'certificatePath'
>;

// System
export type SystemHealth = Schemas['SystemHealth'];
export type SystemResponse = Schemas['SystemResponse'];
export type SecurityStatus = Schemas['SecurityStatus'];
export type ApiKeyInfoResponse = Schemas['ApiKeyInfoResponse'];
export type ApiKeyListResponse = Schemas['ApiKeyListResponse'];
export type CreateApiKeyRequest = Schemas['CreateApiKeyRequest'];
export type CreateApiKeyResponse = Schemas['CreateApiKeyResponse'];
export type FirewallRuleStatusResponse = Schemas['FirewallRuleStatusResponse'];
export type TtyHostInfo = Schemas['TtyHostInfo'];
export type VersionManifest = Schemas['VersionManifest'];
export type PathsResponse = Schemas['PathsResponse'];

// Updates
export type UpdateInfo = Schemas['UpdateInfo'];
export type LocalUpdateInfo = Schemas['LocalUpdateInfo'];
export type UpdateResult = Schemas['UpdateResult'];
export type UpdateType = Schemas['UpdateType'];

// Certificate
export type CertificateInfoResponse = Schemas['CertificateInfoResponse'];
export type CertificateDownloadInfo = Schemas['CertificateDownloadInfo'];

// Share
export type SharePacketInfo = Schemas['SharePacketInfo'];
export type NetworkEndpointInfo = Schemas['NetworkEndpointInfo'];

// Shared sessions
export type ShareAccessMode = Schemas['ShareAccessMode'];
export type CreateShareLinkRequest = Schemas['CreateShareLinkRequest'];
export type CreateShareLinkResponse = Schemas['CreateShareLinkResponse'];
export type ActiveShareGrantInfo = Schemas['ActiveShareGrantInfo'];
export type ActiveShareGrantListResponse = Schemas['ActiveShareGrantListResponse'];
export type ClaimShareRequest = Schemas['ClaimShareRequest'];
export type ClaimShareResponse = Schemas['ClaimShareResponse'];
export type ShareBootstrapResponse = Schemas['ShareBootstrapResponse'];

// Files
export type FilePathInfo = Schemas['FilePathInfo'];
export type FileCheckRequest = Schemas['FileCheckRequest'];
export type FileCheckResponse = Schemas['FileCheckResponse'];
export type FileResolveResponse = Schemas['FileResolveResponse'];
export type FileRegisterRequest = Schemas['FileRegisterRequest'];
export type FileUploadResponse = Schemas['FileUploadResponse'];
export type DirectoryEntry = Schemas['DirectoryEntry'];
export type DirectoryListResponse = Schemas['DirectoryListResponse'];

// History
export type LaunchEntry = Schemas['LaunchEntry'] & {
  surfaceType?: string | null;
  foregroundProcessName?: string | null;
  foregroundProcessCommandLine?: string | null;
  foregroundProcessDisplayName?: string | null;
  foregroundProcessIdentity?: string | null;
};
export type CreateHistoryRequest = Schemas['CreateHistoryRequest'] & {
  dedupeKey?: string | null;
  surfaceType?: 'trm' | 'cdx' | 'cld';
  foregroundProcessName?: string | null;
  foregroundProcessCommandLine?: string | null;
  foregroundProcessDisplayName?: string | null;
  foregroundProcessIdentity?: string | null;
};
export type HistoryPatchRequest = Schemas['HistoryPatchRequest'];

// Shells & Users
export type ShellInfoDto = Schemas['ShellInfoDto'];
export type UserInfo = Schemas['UserInfo'];
export type NetworkInterfaceDto = Schemas['NetworkInterfaceDto'];

// Features
export type FeatureFlags = Schemas['FeatureFlags'];

// =============================================================================
// Enum Types (re-exported from generated)
// =============================================================================

export type ShellType = Schemas['ShellType'];
export type ThemeSetting = Schemas['ThemeSetting'];
export type CursorStyleSetting = Schemas['CursorStyleSetting'];
export type CursorInactiveStyleSetting = Schemas['CursorInactiveStyleSetting'];
export type BellStyleSetting = Schemas['BellStyleSetting'];
export type ClipboardShortcutsSetting = Schemas['ClipboardShortcutsSetting'];
export type TabTitleModeSetting = Schemas['TabTitleModeSetting'];
export type ScrollbarStyleSetting = Schemas['ScrollbarStyleSetting'];
export type TerminalColorSchemeSetting = MidTermSettingsPublic['terminalColorScheme'];
export type LanguageSetting = Schemas['LanguageSetting'];

// =============================================================================
// Client-Extended Types
// =============================================================================

/**
 * Session with client-side properties.
 * Extends the API SessionInfoDto - any API changes will propagate here.
 */
export interface Session extends SessionInfoDto {
  /** Client-side ordering index (used for local sorting before server sync) */
  _order?: number;
}

// =============================================================================
// Type Aliases for Backward Compatibility
// =============================================================================

/** @deprecated Use MidTermSettingsPublic directly */
export type Settings = MidTermSettingsPublic;

/** @deprecated Use AuthStatusResponse directly */
export type AuthStatus = AuthStatusResponse;

/** @deprecated Use SystemHealth directly */
export type HealthResponse = SystemHealth;

/** @deprecated Use ShellInfoDto directly */
export type ShellInfo = ShellInfoDto;

/** @deprecated Use CertificateInfoResponse directly */
export type CertificateInfo = CertificateInfoResponse;

/** @deprecated Use NetworkInterfaceDto directly */
export type NetworkInterface = NetworkInterfaceDto;

// Type aliases for backward compatibility with old naming
export type ThemeName = ThemeSetting;
export type CursorStyle = CursorStyleSetting;
export type CursorInactiveStyle = CursorInactiveStyleSetting;
export type BellStyle = BellStyleSetting;
export type ClipboardShortcuts = ClipboardShortcutsSetting;
export type TabTitleMode = TabTitleModeSetting;
