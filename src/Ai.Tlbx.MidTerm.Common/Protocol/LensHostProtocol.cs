using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Common.Protocol;

public static class LensHostProtocol
{
    public const string CurrentVersion = "lens-host-v1";
}

public sealed class LensQuickSettingsPayload
{
    public string? Model { get; set; }
    public string? Effort { get; set; }
    public string PlanMode { get; set; } = LensQuickSettings.PlanModeOff;
    public string PermissionMode { get; set; } = LensQuickSettings.PermissionModeManual;
}

public sealed class LensQuestion
{
    public string Id { get; set; } = string.Empty;
    public string Header { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public bool MultiSelect { get; set; }
    public List<LensQuestionOption> Options { get; set; } = [];
}

public sealed class LensQuestionOption
{
    public string Label { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
}

public sealed class LensAnsweredQuestion
{
    public string QuestionId { get; set; } = string.Empty;
    public List<string> Answers { get; set; } = [];
}

public sealed class LensHistoryWindowResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public DateTimeOffset GeneratedAt { get; set; }
    public long LatestSequence { get; set; }
    public int HistoryCount { get; set; }
    public int HistoryWindowStart { get; set; }
    public int HistoryWindowEnd { get; set; }
    public bool HasOlderHistory { get; set; }
    public bool HasNewerHistory { get; set; }
    public LensSessionSummary Session { get; set; } = new();
    public LensThreadSummary Thread { get; set; } = new();
    public LensTurnSummary CurrentTurn { get; set; } = new();
    public LensQuickSettingsSummary QuickSettings { get; set; } = new();
    public LensStreamsSummary Streams { get; set; } = new();
    public List<LensHistoryItem> History { get; set; } = [];
    public List<LensItemSummary> Items { get; set; } = [];
    public List<LensRequestSummary> Requests { get; set; } = [];
    public List<LensRuntimeNotice> Notices { get; set; } = [];
}

public sealed class LensHistoryPatch
{
    public string SessionId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public DateTimeOffset GeneratedAt { get; set; }
    public long LatestSequence { get; set; }
    public int HistoryCount { get; set; }
    public LensSessionSummary Session { get; set; } = new();
    public LensThreadSummary Thread { get; set; } = new();
    public LensTurnSummary CurrentTurn { get; set; } = new();
    public LensQuickSettingsSummary QuickSettings { get; set; } = new();
    public LensStreamsSummary Streams { get; set; } = new();
    public List<LensHistoryItem> HistoryUpserts { get; set; } = [];
    public List<string> HistoryRemovals { get; set; } = [];
    public List<LensItemSummary> ItemUpserts { get; set; } = [];
    public List<string> ItemRemovals { get; set; } = [];
    public List<LensRequestSummary> RequestUpserts { get; set; } = [];
    public List<string> RequestRemovals { get; set; } = [];
    public List<LensRuntimeNotice> NoticeUpserts { get; set; } = [];
}

public sealed class LensSessionSummary
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? Reason { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset? LastEventAt { get; set; }
}

public sealed class LensThreadSummary
{
    public string ThreadId { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
}

public sealed class LensTurnSummary
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

    public static LensQuickSettingsPayload ToPayload(LensQuickSettingsSummary summary)
    {
        ArgumentNullException.ThrowIfNull(summary);

        return new LensQuickSettingsPayload
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

public sealed class LensStreamsSummary
{
    public string AssistantText { get; set; } = string.Empty;
    public string ReasoningText { get; set; } = string.Empty;
    public string ReasoningSummaryText { get; set; } = string.Empty;
    public string PlanText { get; set; } = string.Empty;
    public string CommandOutput { get; set; } = string.Empty;
    public string FileChangeOutput { get; set; } = string.Empty;
    public string UnifiedDiff { get; set; } = string.Empty;
}

public sealed class LensHistoryItem
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

public sealed class LensItemSummary
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

public sealed class LensRequestSummary
{
    public string RequestId { get; set; } = string.Empty;
    public string? TurnId { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string KindLabel { get; set; } = string.Empty;
    public string State { get; set; } = string.Empty;
    public string? Detail { get; set; }
    public string? Decision { get; set; }
    public List<LensQuestion> Questions { get; set; } = [];
    public List<LensAnsweredQuestion> Answers { get; set; } = [];
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class LensRuntimeNotice
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
    public List<LensAnsweredQuestion> Answers { get; set; } = [];
}

public sealed class LensCommandAcceptedResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Status { get; set; } = "accepted";
    public string? RequestId { get; set; }
    public string? TurnId { get; set; }
}

public sealed class LensHistoryWindowRequest
{
    public int? StartIndex { get; set; }
    public int? Count { get; set; }
    public string? WindowRevision { get; set; }
}

public sealed class LensWsRequestMessage
{
    public string Type { get; set; } = "request";
    public string Id { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public long? AfterSequence { get; set; }
    public string? RequestId { get; set; }
    public LensHistoryWindowRequest? HistoryWindow { get; set; }
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
    public LensHistoryWindowRequest? HistoryWindow { get; set; }
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

public sealed class LensWsHistoryWindowMessage
{
    public string Type { get; set; } = "history.window";
    public string? Id { get; set; }
    public string SessionId { get; set; } = string.Empty;
    public string? WindowRevision { get; set; }
    public LensHistoryWindowResponse HistoryWindow { get; set; } = new();
}

public sealed class LensWsHistoryPatchMessage
{
    public string Type { get; set; } = "history.patch";
    public string SessionId { get; set; } = string.Empty;
    public LensHistoryPatch Patch { get; set; } = new();
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

public sealed class LensHostHistoryWindowRequest
{
    public int? StartIndex { get; set; }
    public int? Count { get; set; }
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
    public LensHostHistoryWindowRequest? HistoryWindow { get; set; }
}

public sealed class LensRequestResolutionCommand
{
    public string RequestId { get; set; } = string.Empty;
    public string Decision { get; set; } = "accept";
}

public sealed class LensUserInputResolutionCommand
{
    public string RequestId { get; set; } = string.Empty;
    public List<LensAnsweredQuestion> Answers { get; set; } = [];
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
    public LensHistoryWindowResponse? HistoryWindow { get; set; }
}

public sealed class LensHostHistoryPatchEnvelope
{
    public string ProtocolVersion { get; set; } = LensHostProtocol.CurrentVersion;
    public string SessionId { get; set; } = string.Empty;
    public LensHistoryPatch Patch { get; set; } = new();
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LensHostHello))]
[JsonSerializable(typeof(LensHostCommandEnvelope))]
[JsonSerializable(typeof(LensHostCommandResultEnvelope))]
[JsonSerializable(typeof(LensAttachRuntimeRequest))]
[JsonSerializable(typeof(LensHostHistoryWindowRequest))]
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
[JsonSerializable(typeof(LensHistoryWindowRequest))]
[JsonSerializable(typeof(LensWsRequestMessage))]
[JsonSerializable(typeof(LensWsSubscriptionMessage))]
[JsonSerializable(typeof(LensWsAckMessage))]
[JsonSerializable(typeof(LensWsErrorMessage))]
[JsonSerializable(typeof(LensWsHistoryWindowMessage))]
[JsonSerializable(typeof(LensWsHistoryPatchMessage))]
[JsonSerializable(typeof(LensWsTurnStartedMessage))]
[JsonSerializable(typeof(LensWsCommandAcceptedMessage))]
[JsonSerializable(typeof(LensQuickSettingsPayload))]
[JsonSerializable(typeof(LensQuickSettingsSummary))]
[JsonSerializable(typeof(LensQuestion))]
[JsonSerializable(typeof(List<LensQuestion>))]
[JsonSerializable(typeof(LensQuestionOption))]
[JsonSerializable(typeof(List<LensQuestionOption>))]
[JsonSerializable(typeof(LensAnsweredQuestion))]
[JsonSerializable(typeof(List<LensAnsweredQuestion>))]
[JsonSerializable(typeof(LensHistoryWindowResponse))]
[JsonSerializable(typeof(LensHistoryPatch))]
[JsonSerializable(typeof(LensSessionSummary))]
[JsonSerializable(typeof(LensThreadSummary))]
[JsonSerializable(typeof(LensTurnSummary))]
[JsonSerializable(typeof(LensStreamsSummary))]
[JsonSerializable(typeof(LensHistoryItem))]
[JsonSerializable(typeof(List<LensHistoryItem>))]
[JsonSerializable(typeof(LensInlineFileReference))]
[JsonSerializable(typeof(List<LensInlineFileReference>))]
[JsonSerializable(typeof(LensInlineImagePreview))]
[JsonSerializable(typeof(List<LensInlineImagePreview>))]
[JsonSerializable(typeof(LensItemSummary))]
[JsonSerializable(typeof(List<LensItemSummary>))]
[JsonSerializable(typeof(LensRequestSummary))]
[JsonSerializable(typeof(List<LensRequestSummary>))]
[JsonSerializable(typeof(LensRuntimeNotice))]
[JsonSerializable(typeof(List<LensRuntimeNotice>))]
[JsonSerializable(typeof(LensHostHistoryPatchEnvelope))]
public partial class LensHostJsonContext : JsonSerializerContext
{
}






























