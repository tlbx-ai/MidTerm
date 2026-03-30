using System.Globalization;

namespace Ai.Tlbx.MidTerm.Common.Protocol;

public static class LensEventCompaction
{
    private const int MaxRawPayloadChars = 2048;
    private const int MaxAssistantDeltaChars = 16384;
    private const int MaxReasoningDeltaChars = 1024;
    private const int MaxPlanDeltaChars = 4096;
    private const int MaxToolDeltaChars = 2048;
    private const int MaxDiffChars = 16384;
    private const int MaxCommandTextChars = 2048;
    private const int MaxToolItemDetailChars = 4096;
    private const int MaxRequestDetailChars = 2048;
    private const int MaxRuntimeDetailChars = 4096;
    private const int MaxPlanMarkdownChars = 16384;

    public static LensPulseEvent CloneForRetention(LensPulseEvent source)
    {
        ArgumentNullException.ThrowIfNull(source);

        return new LensPulseEvent
        {
            Sequence = source.Sequence,
            EventId = source.EventId,
            SessionId = source.SessionId,
            Provider = source.Provider,
            ThreadId = source.ThreadId,
            TurnId = source.TurnId,
            ItemId = source.ItemId,
            RequestId = source.RequestId,
            CreatedAt = source.CreatedAt,
            Type = source.Type,
            Raw = source.Raw is null ? null : new LensPulseEventRaw
            {
                Source = source.Raw.Source,
                Method = source.Raw.Method,
                PayloadJson = CompactTextMiddle(source.Raw.PayloadJson, MaxRawPayloadChars)
            },
            SessionState = source.SessionState is null ? null : new LensPulseSessionStatePayload
            {
                State = source.SessionState.State,
                StateLabel = source.SessionState.StateLabel,
                Reason = source.SessionState.Reason
            },
            ThreadState = source.ThreadState is null ? null : new LensPulseThreadStatePayload
            {
                State = source.ThreadState.State,
                StateLabel = source.ThreadState.StateLabel,
                ProviderThreadId = source.ThreadState.ProviderThreadId
            },
            TurnStarted = source.TurnStarted is null ? null : new LensPulseTurnStartedPayload
            {
                Model = source.TurnStarted.Model,
                Effort = source.TurnStarted.Effort
            },
            TurnCompleted = source.TurnCompleted is null ? null : new LensPulseTurnCompletedPayload
            {
                State = source.TurnCompleted.State,
                StateLabel = source.TurnCompleted.StateLabel,
                StopReason = source.TurnCompleted.StopReason,
                ErrorMessage = CompactTextMiddle(source.TurnCompleted.ErrorMessage, MaxRuntimeDetailChars)
            },
            ContentDelta = source.ContentDelta is null ? null : new LensPulseContentDeltaPayload
            {
                StreamKind = source.ContentDelta.StreamKind,
                Delta = CompactContentDelta(source.ContentDelta.StreamKind, source.ContentDelta.Delta)
            },
            PlanDelta = source.PlanDelta is null ? null : new LensPulsePlanDeltaPayload
            {
                Delta = CompactTextMiddle(source.PlanDelta.Delta, MaxPlanDeltaChars) ?? string.Empty
            },
            PlanCompleted = source.PlanCompleted is null ? null : new LensPulsePlanCompletedPayload
            {
                PlanMarkdown = CompactTextMiddle(source.PlanCompleted.PlanMarkdown, MaxPlanMarkdownChars) ?? string.Empty
            },
            DiffUpdated = source.DiffUpdated is null ? null : new LensPulseDiffUpdatedPayload
            {
                UnifiedDiff = CompactTextMiddle(source.DiffUpdated.UnifiedDiff, MaxDiffChars) ?? string.Empty
            },
            Item = source.Item is null ? null : new LensPulseItemPayload
            {
                ItemType = source.Item.ItemType,
                Status = source.Item.Status,
                Title = source.Item.Title,
                Detail = CompactItemDetail(source.Item.ItemType, source.Item.Detail),
                Attachments = CloneAttachments(source.Item.Attachments)
            },
            QuickSettingsUpdated = source.QuickSettingsUpdated is null ? null : new LensPulseQuickSettingsPayload
            {
                Model = source.QuickSettingsUpdated.Model,
                Effort = source.QuickSettingsUpdated.Effort,
                PlanMode = LensQuickSettings.NormalizePlanMode(source.QuickSettingsUpdated.PlanMode),
                PermissionMode = LensQuickSettings.NormalizePermissionMode(source.QuickSettingsUpdated.PermissionMode)
            },
            RequestOpened = source.RequestOpened is null ? null : new LensPulseRequestOpenedPayload
            {
                RequestType = source.RequestOpened.RequestType,
                RequestTypeLabel = source.RequestOpened.RequestTypeLabel,
                Detail = CompactTextMiddle(source.RequestOpened.Detail, MaxRequestDetailChars)
            },
            RequestResolved = source.RequestResolved is null ? null : new LensPulseRequestResolvedPayload
            {
                RequestType = source.RequestResolved.RequestType,
                Decision = source.RequestResolved.Decision
            },
            UserInputRequested = source.UserInputRequested is null ? null : new LensPulseUserInputRequestedPayload
            {
                Questions = source.UserInputRequested.Questions.Select(CloneQuestion).ToList()
            },
            UserInputResolved = source.UserInputResolved is null ? null : new LensPulseUserInputResolvedPayload
            {
                Answers = source.UserInputResolved.Answers.Select(CloneAnsweredQuestion).ToList()
            },
            RuntimeMessage = source.RuntimeMessage is null ? null : new LensPulseRuntimeMessagePayload
            {
                Message = source.RuntimeMessage.Message,
                Detail = CompactTextMiddle(source.RuntimeMessage.Detail, MaxRuntimeDetailChars)
            }
        };
    }

    private static string CompactContentDelta(string streamKind, string value)
    {
        var normalized = (streamKind ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "assistant_text" => CompactTextMiddle(value, MaxAssistantDeltaChars),
            "reasoning_text" or "reasoning_summary_text" => CompactTextMiddle(value, MaxReasoningDeltaChars),
            "plan_text" => CompactTextMiddle(value, MaxPlanDeltaChars),
            "command_output" or "file_change_output" => CompactTextMiddle(value, MaxToolDeltaChars),
            _ when normalized.EndsWith("_output", StringComparison.Ordinal) ||
                   normalized.EndsWith("_result", StringComparison.Ordinal)
                => CompactTextMiddle(value, MaxToolDeltaChars),
            _ => value ?? string.Empty
        };
    }

    private static string? CompactItemDetail(string itemType, string? detail)
    {
        var normalized = (itemType ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "command_execution" or "command" => CompactTextMiddle(detail, MaxCommandTextChars),
            "command_output" or "file_change_output" => CompactTextMiddle(detail, MaxToolItemDetailChars),
            _ when normalized.EndsWith("_output", StringComparison.Ordinal) ||
                   normalized.EndsWith("_result", StringComparison.Ordinal)
                => CompactTextMiddle(detail, MaxToolItemDetailChars),
            _ => detail
        };
    }

    private static string CompactTextMiddle(string? value, int maxChars)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= maxChars || maxChars < 32)
        {
            return value ?? string.Empty;
        }

        var omissionCount = value.Length - maxChars;
        var marker = $" ... [{omissionCount.ToString(CultureInfo.InvariantCulture)} chars omitted] ... ";
        var available = maxChars - marker.Length;
        if (available < 8)
        {
            return value[..maxChars];
        }

        var headLength = available / 2;
        var tailLength = available - headLength;
        return string.Concat(value.AsSpan(0, headLength), marker, value.AsSpan(value.Length - tailLength));
    }

    private static List<LensAttachmentReference> CloneAttachments(IReadOnlyList<LensAttachmentReference>? attachments)
    {
        if (attachments is null || attachments.Count == 0)
        {
            return [];
        }

        return attachments.Select(static attachment => new LensAttachmentReference
        {
            Kind = attachment.Kind,
            Path = attachment.Path,
            MimeType = attachment.MimeType,
            DisplayName = attachment.DisplayName
        }).ToList();
    }

    private static LensPulseQuestion CloneQuestion(LensPulseQuestion source)
    {
        return new LensPulseQuestion
        {
            Id = source.Id,
            Header = source.Header,
            Question = source.Question,
            MultiSelect = source.MultiSelect,
            Options = source.Options.Select(static option => new LensPulseQuestionOption
            {
                Label = option.Label,
                Description = option.Description
            }).ToList()
        };
    }

    private static LensPulseAnsweredQuestion CloneAnsweredQuestion(LensPulseAnsweredQuestion source)
    {
        return new LensPulseAnsweredQuestion
        {
            QuestionId = source.QuestionId,
            Answers = [.. source.Answers]
        };
    }
}
