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
export type SessionInfoDto = Schemas['SessionInfoDto'];
export type SessionListDto = Schemas['SessionListDto'];
export type CreateSessionRequest = Schemas['CreateSessionRequest'];
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
export type LensAttachmentReference = Schemas['LensAttachmentReference'];
export type LensCommandAcceptedResponse = Schemas['LensCommandAcceptedResponse'];
export type LensInterruptRequest = Schemas['LensInterruptRequest'];
export type LensPulseAnsweredQuestion = Schemas['LensPulseAnsweredQuestion'];
export type LensPulseContentDeltaPayload = Schemas['LensPulseContentDeltaPayload'];
export type LensPulseDiffUpdatedPayload = Schemas['LensPulseDiffUpdatedPayload'];
export type LensPulseEvent = Schemas['LensPulseEvent'];
export type LensPulseEventListResponse = Schemas['LensPulseEventListResponse'];
export type LensPulseEventRaw = Schemas['LensPulseEventRaw'];
export type LensPulseItemPayload = Schemas['LensPulseItemPayload'];
export type LensPulseItemSummary = Schemas['LensPulseItemSummary'];
export type LensPulsePlanCompletedPayload = Schemas['LensPulsePlanCompletedPayload'];
export type LensPulsePlanDeltaPayload = Schemas['LensPulsePlanDeltaPayload'];
export type LensPulseQuestion = Schemas['LensPulseQuestion'];
export type LensPulseQuestionOption = Schemas['LensPulseQuestionOption'];
export type LensPulseRequestOpenedPayload = Schemas['LensPulseRequestOpenedPayload'];
export type LensPulseRequestResolvedPayload = Schemas['LensPulseRequestResolvedPayload'];
export type LensPulseRequestSummary = Schemas['LensPulseRequestSummary'];
export type LensPulseRuntimeMessagePayload = Schemas['LensPulseRuntimeMessagePayload'];
export type LensPulseRuntimeNotice = Schemas['LensPulseRuntimeNotice'];
export type LensPulseSessionStatePayload = Schemas['LensPulseSessionStatePayload'];
export type LensPulseSessionSummary = Schemas['LensPulseSessionSummary'];
export type LensPulseSnapshotResponse = Schemas['LensPulseSnapshotResponse'];
export type LensPulseStreamsSummary = Schemas['LensPulseStreamsSummary'];
export type LensPulseThreadStatePayload = Schemas['LensPulseThreadStatePayload'];
export type LensPulseThreadSummary = Schemas['LensPulseThreadSummary'];
export type LensPulseTurnCompletedPayload = Schemas['LensPulseTurnCompletedPayload'];
export type LensPulseTurnStartedPayload = Schemas['LensPulseTurnStartedPayload'];
export type LensPulseTurnSummary = Schemas['LensPulseTurnSummary'];
export type LensPulseUserInputRequestedPayload = Schemas['LensPulseUserInputRequestedPayload'];
export type LensPulseUserInputResolvedPayload = Schemas['LensPulseUserInputResolvedPayload'];
export type LensRequestDecisionRequest = Schemas['LensRequestDecisionRequest'];
export type LensTurnRequest = Schemas['LensTurnRequest'];
export type LensTurnStartResponse = Schemas['LensTurnStartResponse'];
export type LensUserInputAnswerRequest = Schemas['LensUserInputAnswerRequest'];

// Settings
export type MidTermSettingsPublic = Schemas['MidTermSettingsPublic'];
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
export type LaunchEntry = Schemas['LaunchEntry'];
export type CreateHistoryRequest = Schemas['CreateHistoryRequest'] & {
  dedupeKey?: string | null;
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
export type TerminalColorSchemeSetting = Schemas['TerminalColorSchemeSetting'];
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
