using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Common.Protocol;

public static class LensHostProtocol
{
    public const string CurrentVersion = "lens-host-v1";
}

public sealed class LensPulseEvent
{
    public long Sequence { get; set; }
    public string EventId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string ThreadId { get; set; } = string.Empty;
    public string? TurnId { get; set; }
    public string? ItemId { get; set; }
    public string? RequestId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public string Type { get; set; } = string.Empty;
    public LensPulseEventRaw? Raw { get; set; }
    public LensPulseSessionStatePayload? SessionState { get; set; }
    public LensPulseThreadStatePayload? ThreadState { get; set; }
    public LensPulseTurnStartedPayload? TurnStarted { get; set; }
    public LensPulseTurnCompletedPayload? TurnCompleted { get; set; }
    public LensPulseContentDeltaPayload? ContentDelta { get; set; }
    public LensPulsePlanDeltaPayload? PlanDelta { get; set; }
    public LensPulsePlanCompletedPayload? PlanCompleted { get; set; }
    public LensPulseDiffUpdatedPayload? DiffUpdated { get; set; }
    public LensPulseItemPayload? Item { get; set; }
    public LensPulseQuickSettingsPayload? QuickSettingsUpdated { get; set; }
    public LensPulseRequestOpenedPayload? RequestOpened { get; set; }
    public LensPulseRequestResolvedPayload? RequestResolved { get; set; }
    public LensPulseUserInputRequestedPayload? UserInputRequested { get; set; }
    public LensPulseUserInputResolvedPayload? UserInputResolved { get; set; }
    public LensPulseRuntimeMessagePayload? RuntimeMessage { get; set; }
}

public sealed class LensPulseEventRaw
{
    public string Source { get; set; } = string.Empty;
    public string? Method { get; set; }
    public string? PayloadJson { get; set; }
}

public sealed class LensPulseSessionStatePayload
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? Reason { get; set; }
}

public sealed class LensPulseThreadStatePayload
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? ProviderThreadId { get; set; }
}

public sealed class LensPulseTurnStartedPayload
{
    public string? Model { get; set; }
    public string? Effort { get; set; }
}

public sealed class LensPulseTurnCompletedPayload
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? StopReason { get; set; }
    public string? ErrorMessage { get; set; }
}

public sealed class LensPulseContentDeltaPayload
{
    public string StreamKind { get; set; } = string.Empty;
    public string Delta { get; set; } = string.Empty;
}

public sealed class LensPulsePlanDeltaPayload
{
    public string Delta { get; set; } = string.Empty;
}

public sealed class LensPulsePlanCompletedPayload
{
    public string PlanMarkdown { get; set; } = string.Empty;
}

public sealed class LensPulseDiffUpdatedPayload
{
    public string UnifiedDiff { get; set; } = string.Empty;
}

public sealed class LensPulseItemPayload
{
    public string ItemType { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Detail { get; set; }
    public List<LensAttachmentReference> Attachments { get; set; } = [];
}

public sealed class LensPulseQuickSettingsPayload
{
    public string? Model { get; set; }
    public string? Effort { get; set; }
    public string PlanMode { get; set; } = LensQuickSettings.PlanModeOff;
    public string PermissionMode { get; set; } = LensQuickSettings.PermissionModeManual;
}

public sealed class LensPulseRequestOpenedPayload
{
    public string RequestType { get; set; } = string.Empty;
    public string RequestTypeLabel { get; set; } = string.Empty;
    public string? Detail { get; set; }
}

public sealed class LensPulseRequestResolvedPayload
{
    public string RequestType { get; set; } = string.Empty;
    public string? Decision { get; set; }
}

public sealed class LensPulseUserInputRequestedPayload
{
    public List<LensPulseQuestion> Questions { get; set; } = [];
}

public sealed class LensPulseUserInputResolvedPayload
{
    public List<LensPulseAnsweredQuestion> Answers { get; set; } = [];
}

public sealed class LensPulseRuntimeMessagePayload
{
    public string Message { get; set; } = string.Empty;
    public string? Detail { get; set; }
}

public sealed class LensPulseQuestion
{
    public string Id { get; set; } = string.Empty;
    public string Header { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public bool MultiSelect { get; set; }
    public List<LensPulseQuestionOption> Options { get; set; } = [];
}

public sealed class LensPulseQuestionOption
{
    public string Label { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
}

public sealed class LensPulseAnsweredQuestion
{
    public string QuestionId { get; set; } = string.Empty;
    public List<string> Answers { get; set; } = [];
}

public sealed class LensPulseEventListResponse
{
    public string SessionId { get; set; } = string.Empty;
    public long LatestSequence { get; set; }
    public List<LensPulseEvent> Events { get; set; } = [];
}

public sealed class LensPulseDeltaResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public DateTimeOffset GeneratedAt { get; set; }
    public long LatestSequence { get; set; }
    public int TotalHistoryCount { get; set; }
    public int EstimatedTotalHistoryHeightPx { get; set; }
    public LensPulseSessionSummary Session { get; set; } = new();
    public LensPulseThreadSummary Thread { get; set; } = new();
    public LensPulseTurnSummary CurrentTurn { get; set; } = new();
    public LensQuickSettingsSummary QuickSettings { get; set; } = new();
    public LensPulseStreamsSummary Streams { get; set; } = new();
    public List<LensPulseTranscriptEntry> HistoryUpserts { get; set; } = [];
    public List<string> HistoryRemovals { get; set; } = [];
    public List<LensPulseItemSummary> ItemUpserts { get; set; } = [];
    public List<string> ItemRemovals { get; set; } = [];
    public List<LensPulseRequestSummary> RequestUpserts { get; set; } = [];
    public List<string> RequestRemovals { get; set; } = [];
    public List<LensPulseRuntimeNotice> NoticeUpserts { get; set; } = [];
}

public sealed class LensPulseSnapshotResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public DateTimeOffset GeneratedAt { get; set; }
    public long LatestSequence { get; set; }
    public int TotalHistoryCount { get; set; }
    public int EstimatedTotalHistoryHeightPx { get; set; }
    public int EstimatedHistoryBeforeWindowPx { get; set; }
    public int EstimatedHistoryAfterWindowPx { get; set; }
    public int HistoryWindowStart { get; set; }
    public int HistoryWindowEnd { get; set; }
    public bool HasOlderHistory { get; set; }
    public bool HasNewerHistory { get; set; }
    public LensPulseSessionSummary Session { get; set; } = new();
    public LensPulseThreadSummary Thread { get; set; } = new();
    public LensPulseTurnSummary CurrentTurn { get; set; } = new();
    public LensQuickSettingsSummary QuickSettings { get; set; } = new();
    public LensPulseStreamsSummary Streams { get; set; } = new();
    public List<LensPulseTranscriptEntry> Transcript { get; set; } = [];
    public List<LensPulseItemSummary> Items { get; set; } = [];
    public List<LensPulseRequestSummary> Requests { get; set; } = [];
    public List<LensPulseRuntimeNotice> Notices { get; set; } = [];
}

public sealed class LensPulseSessionSummary
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? Reason { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset? LastEventAt { get; set; }
}

public sealed class LensPulseThreadSummary
{
    public string ThreadId { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
}

public sealed class LensPulseTurnSummary
{
    public string? TurnId { get; set; }
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? Model { get; set; }
    public string? Effort { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
}

public static class LensQuickSettings
{
    public const string PlanModeOff = "off";
    public const string PlanModeOn = "on";
    public const string PermissionModeManual = "manual";
    public const string PermissionModeAuto = "auto";

    public static string NormalizePlanMode(string? value)
    {
        return string.Equals(value?.Trim(), PlanModeOn, StringComparison.OrdinalIgnoreCase)
            ? PlanModeOn
            : PlanModeOff;
    }

    public static string NormalizePermissionMode(string? value)
    {
        return string.Equals(value?.Trim(), PermissionModeAuto, StringComparison.OrdinalIgnoreCase)
            ? PermissionModeAuto
            : PermissionModeManual;
    }

    public static string? NormalizeOptionalValue(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    public static LensQuickSettingsSummary CreateSummary(
        string? model,
        string? effort,
        string? planMode,
        string? permissionMode,
        string? defaultPermissionMode = null)
    {
        return new LensQuickSettingsSummary
        {
            Model = NormalizeOptionalValue(model),
            Effort = NormalizeOptionalValue(effort),
            PlanMode = NormalizePlanMode(planMode),
            PermissionMode = NormalizePermissionMode(
                string.IsNullOrWhiteSpace(permissionMode) ? defaultPermissionMode : permissionMode)
        };
    }

    public static LensPulseQuickSettingsPayload ToPayload(LensQuickSettingsSummary summary)
    {
        ArgumentNullException.ThrowIfNull(summary);

        return new LensPulseQuickSettingsPayload
        {
            Model = NormalizeOptionalValue(summary.Model),
            Effort = NormalizeOptionalValue(summary.Effort),
            PlanMode = NormalizePlanMode(summary.PlanMode),
            PermissionMode = NormalizePermissionMode(summary.PermissionMode)
        };
    }

    public static string ApplyPlanModePrompt(string? text, string? planMode)
    {
        var prompt = NormalizeOptionalValue(text);
        if (!string.Equals(NormalizePlanMode(planMode), PlanModeOn, StringComparison.Ordinal))
        {
            return prompt ?? string.Empty;
        }

        const string planInstruction =
            "MidTerm plan mode is enabled for this turn. Start with a concise step-by-step plan, keep it updated while you work, and use native planning capabilities when available.";

        return string.IsNullOrWhiteSpace(prompt)
            ? planInstruction
            : planInstruction + Environment.NewLine + Environment.NewLine + prompt;
    }
}

public sealed class LensQuickSettingsSummary
{
    public string? Model { get; set; }
    public string? Effort { get; set; }
    public string PlanMode { get; set; } = LensQuickSettings.PlanModeOff;
    public string PermissionMode { get; set; } = LensQuickSettings.PermissionModeManual;
}

public sealed class LensPulseStreamsSummary
{
    public string AssistantText { get; set; } = string.Empty;
    public string ReasoningText { get; set; } = string.Empty;
    public string ReasoningSummaryText { get; set; } = string.Empty;
    public string PlanText { get; set; } = string.Empty;
    public string CommandOutput { get; set; } = string.Empty;
    public string FileChangeOutput { get; set; } = string.Empty;
    public string UnifiedDiff { get; set; } = string.Empty;
}

public sealed class LensPulseTranscriptEntry
{
    public string EntryId { get; set; } = string.Empty;
    public long Order { get; set; }
    public int EstimatedHeightPx { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string? TurnId { get; set; }
    public string? ItemId { get; set; }
    public string? RequestId { get; set; }
    public string Status { get; set; } = string.Empty;
    public string? ItemType { get; set; }
    public string? Title { get; set; }
    public string? CommandText { get; set; }
    public string Body { get; set; } = string.Empty;
    public List<LensAttachmentReference> Attachments { get; set; } = [];
    public List<LensInlineFileReference> FileMentions { get; set; } = [];
    public List<LensInlineImagePreview> ImagePreviews { get; set; } = [];
    public bool Streaming { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    [JsonIgnore]
    public string? EnrichmentSourceSignature { get; set; }
}

public sealed class LensInlineFileReference
{
    public string Field { get; set; } = "body";
    public string DisplayText { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string PathKind { get; set; } = "relative";
    public string? ResolvedPath { get; set; }
    public bool Exists { get; set; }
    public bool IsDirectory { get; set; }
    public string? MimeType { get; set; }
    public int? Line { get; set; }
    public int? Column { get; set; }
}

public sealed class LensInlineImagePreview
{
    public string DisplayPath { get; set; } = string.Empty;
    public string ResolvedPath { get; set; } = string.Empty;
    public string? MimeType { get; set; }
}

public sealed class LensPulseItemSummary
{
    public string ItemId { get; set; } = string.Empty;
    public string? TurnId { get; set; }
    public string ItemType { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Detail { get; set; }
    public List<LensAttachmentReference> Attachments { get; set; } = [];
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class LensPulseRequestSummary
{
    public string RequestId { get; set; } = string.Empty;
    public string? TurnId { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string KindLabel { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string? Detail { get; set; }
    public string? Decision { get; set; }
    public List<LensPulseQuestion> Questions { get; set; } = [];
    public List<LensPulseAnsweredQuestion> Answers { get; set; } = [];
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class LensPulseRuntimeNotice
{
    public string EventId { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string? Detail { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class LensTurnRequest
{
    public string? Text { get; set; }
    public string? Model { get; set; }
    public string? Effort { get; set; }
    public string? PlanMode { get; set; }
    public string? PermissionMode { get; set; }
    public List<LensAttachmentReference> Attachments { get; set; } = [];
}

public sealed class LensAttachmentReference
{
    public string Kind { get; set; } = "file";
    public string Path { get; set; } = string.Empty;
    public string? MimeType { get; set; }
    public string? DisplayName { get; set; }
}

public sealed class LensTurnStartResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string ThreadId { get; set; } = string.Empty;
    public string? TurnId { get; set; }
    public string Status { get; set; } = "accepted";
    public LensQuickSettingsSummary QuickSettings { get; set; } = new();
}

public sealed class LensInterruptRequest
{
    public string? TurnId { get; set; }
}

public sealed class LensRequestDecisionRequest
{
    public string Decision { get; set; } = "accept";
}

public sealed class LensUserInputAnswerRequest
{
    public List<LensPulseAnsweredQuestion> Answers { get; set; } = [];
}

public sealed class LensCommandAcceptedResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Status { get; set; } = "accepted";
    public string? RequestId { get; set; }
    public string? TurnId { get; set; }
}

public sealed class LensSnapshotWindowRequest
{
    public int? StartIndex { get; set; }
    public int? Count { get; set; }
}

public sealed class LensEventsRequest
{
    public long AfterSequence { get; set; }
}

public sealed class LensWsRequestMessage
{
    public string Type { get; set; } = "request";
    public string Id { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public long? AfterSequence { get; set; }
    public string? RequestId { get; set; }
    public LensSnapshotWindowRequest? SnapshotWindow { get; set; }
    public LensTurnRequest? Turn { get; set; }
    public LensInterruptRequest? Interrupt { get; set; }
    public LensRequestDecisionRequest? RequestDecision { get; set; }
    public LensUserInputAnswerRequest? UserInputAnswer { get; set; }
}

public sealed class LensWsSubscriptionMessage
{
    public string Type { get; set; } = "subscribe";
    public string SessionId { get; set; } = string.Empty;
    public long AfterSequence { get; set; }
    public LensSnapshotWindowRequest? SnapshotWindow { get; set; }
}

public sealed class LensWsAckMessage
{
    public string Type { get; set; } = "ack";
    public string Id { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
}

public sealed class LensWsErrorMessage
{
    public string Type { get; set; } = "error";
    public string? Id { get; set; }
    public string? Action { get; set; }
    public string? SessionId { get; set; }
    public string Message { get; set; } = string.Empty;
}

public sealed class LensWsSnapshotMessage
{
    public string Type { get; set; } = "snapshot";
    public string? Id { get; set; }
    public string SessionId { get; set; } = string.Empty;
    public LensPulseSnapshotResponse Snapshot { get; set; } = new();
}

public sealed class LensWsEventsMessage
{
    public string Type { get; set; } = "events";
    public string? Id { get; set; }
    public string SessionId { get; set; } = string.Empty;
    public LensPulseEventListResponse Events { get; set; } = new();
}

public sealed class LensWsEventMessage
{
    public string Type { get; set; } = "event";
    public string SessionId { get; set; } = string.Empty;
    public LensPulseEvent Event { get; set; } = new();
}

public sealed class LensWsDeltaMessage
{
    public string Type { get; set; } = "delta";
    public string SessionId { get; set; } = string.Empty;
    public LensPulseDeltaResponse Delta { get; set; } = new();
}

public sealed class LensWsTurnStartedMessage
{
    public string Type { get; set; } = "turnStarted";
    public string Id { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public LensTurnStartResponse Response { get; set; } = new();
}

public sealed class LensWsCommandAcceptedMessage
{
    public string Type { get; set; } = "commandAccepted";
    public string Id { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public LensCommandAcceptedResponse Response { get; set; } = new();
}

public sealed class LensHostHello
{
    public string ProtocolVersion { get; set; } = LensHostProtocol.CurrentVersion;
    public string HostKind { get; set; } = "mtagenthost";
    public string HostVersion { get; set; } = "dev";
    public List<string> Providers { get; set; } = [];
    public List<string> Capabilities { get; set; } = [];
}

public sealed class LensAttachRuntimeRequest
{
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string WorkingDirectory { get; set; } = string.Empty;
    public string? InstanceId { get; set; }
    public string? OwnerToken { get; set; }
    public SessionAgentAttachPoint? AttachPoint { get; set; }
    public string? ExecutablePath { get; set; }
    public string? UserProfileDirectory { get; set; }
    public string? ResumeThreadId { get; set; }
}

public sealed class LensHostEventsRequest
{
    public long AfterSequence { get; set; }
}

public sealed class LensHostCommandEnvelope
{
    public string ProtocolVersion { get; set; } = LensHostProtocol.CurrentVersion;
    public string CommandId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public LensAttachRuntimeRequest? AttachRuntime { get; set; }
    public LensTurnRequest? StartTurn { get; set; }
    public LensInterruptRequest? InterruptTurn { get; set; }
    public LensRequestResolutionCommand? ResolveRequest { get; set; }
    public LensUserInputResolutionCommand? ResolveUserInput { get; set; }
    public LensHostEventsRequest? EventsRequest { get; set; }
}

public sealed class LensRequestResolutionCommand
{
    public string RequestId { get; set; } = string.Empty;
    public string Decision { get; set; } = "accept";
}

public sealed class LensUserInputResolutionCommand
{
    public string RequestId { get; set; } = string.Empty;
    public List<LensPulseAnsweredQuestion> Answers { get; set; } = [];
}

public sealed class LensHostCommandResultEnvelope
{
    public string ProtocolVersion { get; set; } = LensHostProtocol.CurrentVersion;
    public string CommandId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string Status { get; set; } = "accepted";
    public string? Message { get; set; }
    public LensTurnStartResponse? TurnStarted { get; set; }
    public LensCommandAcceptedResponse? Accepted { get; set; }
    public LensPulseEventListResponse? Events { get; set; }
}

public sealed class LensHostEventEnvelope
{
    public string ProtocolVersion { get; set; } = LensHostProtocol.CurrentVersion;
    public string SessionId { get; set; } = string.Empty;
    public LensPulseEvent Event { get; set; } = new();
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LensHostHello))]
[JsonSerializable(typeof(LensHostCommandEnvelope))]
[JsonSerializable(typeof(LensHostCommandResultEnvelope))]
[JsonSerializable(typeof(LensHostEventEnvelope))]
[JsonSerializable(typeof(LensAttachRuntimeRequest))]
[JsonSerializable(typeof(LensHostEventsRequest))]
[JsonSerializable(typeof(SessionAgentAttachPoint))]
[JsonSerializable(typeof(LensRequestResolutionCommand))]
[JsonSerializable(typeof(LensUserInputResolutionCommand))]
[JsonSerializable(typeof(LensTurnRequest))]
[JsonSerializable(typeof(LensAttachmentReference))]
[JsonSerializable(typeof(LensTurnStartResponse))]
[JsonSerializable(typeof(LensInterruptRequest))]
[JsonSerializable(typeof(LensRequestDecisionRequest))]
[JsonSerializable(typeof(LensUserInputAnswerRequest))]
[JsonSerializable(typeof(LensCommandAcceptedResponse))]
[JsonSerializable(typeof(LensSnapshotWindowRequest))]
[JsonSerializable(typeof(LensEventsRequest))]
[JsonSerializable(typeof(LensWsRequestMessage))]
[JsonSerializable(typeof(LensWsSubscriptionMessage))]
[JsonSerializable(typeof(LensWsAckMessage))]
[JsonSerializable(typeof(LensWsErrorMessage))]
[JsonSerializable(typeof(LensWsSnapshotMessage))]
[JsonSerializable(typeof(LensWsEventsMessage))]
[JsonSerializable(typeof(LensWsEventMessage))]
[JsonSerializable(typeof(LensWsDeltaMessage))]
[JsonSerializable(typeof(LensWsTurnStartedMessage))]
[JsonSerializable(typeof(LensWsCommandAcceptedMessage))]
[JsonSerializable(typeof(LensPulseEvent))]
[JsonSerializable(typeof(List<LensPulseEvent>))]
[JsonSerializable(typeof(LensPulseDeltaResponse))]
[JsonSerializable(typeof(LensPulseEventRaw))]
[JsonSerializable(typeof(LensPulseSessionStatePayload))]
[JsonSerializable(typeof(LensPulseThreadStatePayload))]
[JsonSerializable(typeof(LensPulseTurnStartedPayload))]
[JsonSerializable(typeof(LensPulseTurnCompletedPayload))]
[JsonSerializable(typeof(LensPulseContentDeltaPayload))]
[JsonSerializable(typeof(LensPulsePlanDeltaPayload))]
[JsonSerializable(typeof(LensPulsePlanCompletedPayload))]
[JsonSerializable(typeof(LensPulseDiffUpdatedPayload))]
[JsonSerializable(typeof(LensPulseItemPayload))]
[JsonSerializable(typeof(LensPulseQuickSettingsPayload))]
[JsonSerializable(typeof(LensPulseRequestOpenedPayload))]
[JsonSerializable(typeof(LensPulseRequestResolvedPayload))]
[JsonSerializable(typeof(LensPulseUserInputRequestedPayload))]
[JsonSerializable(typeof(LensPulseUserInputResolvedPayload))]
[JsonSerializable(typeof(LensPulseRuntimeMessagePayload))]
[JsonSerializable(typeof(LensQuickSettingsSummary))]
[JsonSerializable(typeof(LensPulseQuestion))]
[JsonSerializable(typeof(List<LensPulseQuestion>))]
[JsonSerializable(typeof(LensPulseQuestionOption))]
[JsonSerializable(typeof(List<LensPulseQuestionOption>))]
[JsonSerializable(typeof(LensPulseAnsweredQuestion))]
[JsonSerializable(typeof(List<LensPulseAnsweredQuestion>))]
[JsonSerializable(typeof(LensPulseEventListResponse))]
[JsonSerializable(typeof(LensPulseSnapshotResponse))]
[JsonSerializable(typeof(LensPulseSessionSummary))]
[JsonSerializable(typeof(LensPulseThreadSummary))]
[JsonSerializable(typeof(LensPulseTurnSummary))]
[JsonSerializable(typeof(LensPulseStreamsSummary))]
[JsonSerializable(typeof(LensPulseTranscriptEntry))]
[JsonSerializable(typeof(List<LensPulseTranscriptEntry>))]
[JsonSerializable(typeof(LensInlineFileReference))]
[JsonSerializable(typeof(List<LensInlineFileReference>))]
[JsonSerializable(typeof(LensInlineImagePreview))]
[JsonSerializable(typeof(List<LensInlineImagePreview>))]
[JsonSerializable(typeof(LensPulseItemSummary))]
[JsonSerializable(typeof(List<LensPulseItemSummary>))]
[JsonSerializable(typeof(LensPulseRequestSummary))]
[JsonSerializable(typeof(List<LensPulseRequestSummary>))]
[JsonSerializable(typeof(LensPulseRuntimeNotice))]
[JsonSerializable(typeof(List<LensPulseRuntimeNotice>))]
public partial class LensHostJsonContext : JsonSerializerContext
{
}
