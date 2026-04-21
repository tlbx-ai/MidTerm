using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Common.Protocol;

public sealed class LensProviderEvent
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
    public LensProviderEventRaw? Raw { get; set; }
    public LensProviderSessionStatePayload? SessionState { get; set; }
    public LensProviderThreadStatePayload? ThreadState { get; set; }
    public LensProviderTurnStartedPayload? TurnStarted { get; set; }
    public LensProviderTurnCompletedPayload? TurnCompleted { get; set; }
    public LensProviderContentDeltaPayload? ContentDelta { get; set; }
    public LensProviderPlanDeltaPayload? PlanDelta { get; set; }
    public LensProviderPlanCompletedPayload? PlanCompleted { get; set; }
    public LensProviderDiffUpdatedPayload? DiffUpdated { get; set; }
    public LensProviderItemPayload? Item { get; set; }
    public LensProviderTaskPayload? Task { get; set; }
    public LensQuickSettingsPayload? QuickSettingsUpdated { get; set; }
    public LensProviderRequestOpenedPayload? RequestOpened { get; set; }
    public LensProviderRequestResolvedPayload? RequestResolved { get; set; }
    public LensProviderUserInputRequestedPayload? UserInputRequested { get; set; }
    public LensProviderUserInputResolvedPayload? UserInputResolved { get; set; }
    public LensProviderRuntimeMessagePayload? RuntimeMessage { get; set; }
}

public sealed class LensProviderEventRaw
{
    public string Source { get; set; } = string.Empty;
    public string? Method { get; set; }
    public string? PayloadJson { get; set; }
}

public sealed class LensProviderSessionStatePayload
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? Reason { get; set; }
}

public sealed class LensProviderThreadStatePayload
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? ProviderThreadId { get; set; }
}

public sealed class LensProviderTurnStartedPayload
{
    public string? Model { get; set; }
    public string? Effort { get; set; }
}

public sealed class LensProviderTurnCompletedPayload
{
    public string State { get; set; } = string.Empty;
    public string StateLabel { get; set; } = string.Empty;
    public string? StopReason { get; set; }
    public string? ErrorMessage { get; set; }
}

public sealed class LensProviderContentDeltaPayload
{
    public string StreamKind { get; set; } = string.Empty;
    public string Delta { get; set; } = string.Empty;
}

public sealed class LensProviderPlanDeltaPayload
{
    public string Delta { get; set; } = string.Empty;
}

public sealed class LensProviderPlanCompletedPayload
{
    public string PlanMarkdown { get; set; } = string.Empty;
}

public sealed class LensProviderDiffUpdatedPayload
{
    public string UnifiedDiff { get; set; } = string.Empty;
}

public sealed class LensProviderItemPayload
{
    public string ItemType { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Detail { get; set; }
    public List<LensAttachmentReference> Attachments { get; set; } = [];
}

public sealed class LensProviderTaskPayload
{
    public string TaskId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string? TaskType { get; set; }
    public string? Description { get; set; }
    public string? Summary { get; set; }
    public string? LastToolName { get; set; }
    public string? UsageJson { get; set; }
}

public sealed class LensProviderRequestOpenedPayload
{
    public string RequestType { get; set; } = string.Empty;
    public string RequestTypeLabel { get; set; } = string.Empty;
    public string? Detail { get; set; }
}

public sealed class LensProviderRequestResolvedPayload
{
    public string RequestType { get; set; } = string.Empty;
    public string? Decision { get; set; }
}

public sealed class LensProviderUserInputRequestedPayload
{
    public List<LensQuestion> Questions { get; set; } = [];
}

public sealed class LensProviderUserInputResolvedPayload
{
    public List<LensAnsweredQuestion> Answers { get; set; } = [];
}

public sealed class LensProviderRuntimeMessagePayload
{
    public string Message { get; set; } = string.Empty;
    public string? Detail { get; set; }
}

public sealed class LensProviderEventListResponse
{
    public string SessionId { get; set; } = string.Empty;
    public long LatestSequence { get; set; }
    public List<LensProviderEvent> Events { get; set; } = [];
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LensProviderEvent))]
[JsonSerializable(typeof(List<LensProviderEvent>))]
[JsonSerializable(typeof(LensProviderEventRaw))]
[JsonSerializable(typeof(LensProviderSessionStatePayload))]
[JsonSerializable(typeof(LensProviderThreadStatePayload))]
[JsonSerializable(typeof(LensProviderTurnStartedPayload))]
[JsonSerializable(typeof(LensProviderTurnCompletedPayload))]
[JsonSerializable(typeof(LensProviderContentDeltaPayload))]
[JsonSerializable(typeof(LensProviderPlanDeltaPayload))]
[JsonSerializable(typeof(LensProviderPlanCompletedPayload))]
[JsonSerializable(typeof(LensProviderDiffUpdatedPayload))]
[JsonSerializable(typeof(LensProviderItemPayload))]
[JsonSerializable(typeof(LensProviderTaskPayload))]
[JsonSerializable(typeof(LensProviderRequestOpenedPayload))]
[JsonSerializable(typeof(LensProviderRequestResolvedPayload))]
[JsonSerializable(typeof(LensProviderUserInputRequestedPayload))]
[JsonSerializable(typeof(LensProviderUserInputResolvedPayload))]
[JsonSerializable(typeof(LensProviderRuntimeMessagePayload))]
[JsonSerializable(typeof(LensProviderEventListResponse))]
public partial class LensProviderEventJsonContext : JsonSerializerContext
{
}
