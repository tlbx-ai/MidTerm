using System.Globalization;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class SyntheticAppServerControlAgentRuntime : IAppServerControlAgentRuntime
{
    private readonly string _provider;
    private long _sequence;
    private string? _threadId;
    private string? _activeTurnId;
    private string? _pendingRequestId;

    public SyntheticAppServerControlAgentRuntime(string provider, Action<AppServerControlProviderEvent> emit)
    {
        _provider = provider;
    }

    public string Provider => _provider;

    public ValueTask DisposeAsync()
    {
        return ValueTask.CompletedTask;
    }

    public Task<HostCommandOutcome> ExecuteAsync(AppServerControlHostCommandEnvelope command, CancellationToken ct)
    {
        List<AppServerControlProviderEvent> events = command.Type switch
        {
            "runtime.attach" => AttachRuntime(command),
            "turn.start" => StartTurn(command),
            "turn.interrupt" => InterruptTurn(command),
            "request.resolve" => ResolveRequest(command),
            "user-input.resolve" => ResolveUserInput(command),
            _ => throw new InvalidOperationException($"Unknown synthetic command type '{command.Type}'.")
        };

        var result = new AppServerControlHostCommandResultEnvelope
        {
            CommandId = command.CommandId,
            SessionId = command.SessionId,
            Status = "accepted",
            Accepted = new AppServerControlCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                RequestId = _pendingRequestId,
                TurnId = _activeTurnId
            }
        };

        if (command.Type == "turn.start")
        {
            result.TurnStarted = new AppServerControlTurnStartResponse
            {
                SessionId = command.SessionId,
                Provider = _provider,
                ThreadId = _threadId ?? "thread-synthetic",
                TurnId = _activeTurnId,
                Status = "accepted"
            };
        }

        return Task.FromResult(new HostCommandOutcome
        {
            Result = result,
            Events = events
        });
    }

    private List<AppServerControlProviderEvent> AttachRuntime(AppServerControlHostCommandEnvelope command)
    {
        _threadId = command.AttachRuntime?.ResumeThreadId ?? "thread-synthetic";
        return
        [
            Event(command.SessionId, "session.started", configure: appServerControlEvent =>
            {
                appServerControlEvent.SessionState = new AppServerControlProviderSessionStatePayload
                {
                    State = "starting",
                    StateLabel = "Starting"
                };
            }),
            Event(command.SessionId, "session.ready", configure: appServerControlEvent =>
            {
                appServerControlEvent.SessionState = new AppServerControlProviderSessionStatePayload
                {
                    State = "ready",
                    StateLabel = "Ready"
                };
            }),
            Event(command.SessionId, "thread.started", configure: appServerControlEvent =>
            {
                appServerControlEvent.ThreadState = new AppServerControlProviderThreadStatePayload
                {
                    State = "active",
                    StateLabel = "Active",
                    ProviderThreadId = _threadId
                };
            })
        ];
    }

    private List<AppServerControlProviderEvent> StartTurn(AppServerControlHostCommandEnvelope command)
    {
        _threadId ??= "thread-synthetic";
        _activeTurnId = string.Create(CultureInfo.InvariantCulture, $"turn-{_sequence + 1}");
        _pendingRequestId = "req-approval-1";

        return
        [
            Event(command.SessionId, "turn.started", _activeTurnId, configure: appServerControlEvent =>
            {
                appServerControlEvent.TurnStarted = new AppServerControlProviderTurnStartedPayload
                {
                    Model = command.StartTurn?.Model ?? $"{_provider}-synthetic",
                    Effort = command.StartTurn?.Effort ?? "medium"
                };
            }),
            Event(command.SessionId, "content.delta", _activeTurnId, configure: appServerControlEvent =>
            {
                appServerControlEvent.ContentDelta = new AppServerControlProviderContentDeltaPayload
                {
                    StreamKind = "assistant_text",
                    Delta = $"Synthetic {_provider} reply for: {command.StartTurn?.Text ?? "(empty)"}"
                };
            }),
            Event(command.SessionId, "content.delta", _activeTurnId, configure: appServerControlEvent =>
            {
                appServerControlEvent.ContentDelta = new AppServerControlProviderContentDeltaPayload
                {
                    StreamKind = "reasoning_text",
                    Delta = "Inspecting workspace and shaping the next step."
                };
            }),
            Event(command.SessionId, "plan.completed", _activeTurnId, configure: appServerControlEvent =>
            {
                appServerControlEvent.PlanCompleted = new AppServerControlProviderPlanCompletedPayload
                {
                    PlanMarkdown = "1. Read the repo.\n2. Apply a focused patch.\n3. Verify the result."
                };
            }),
            Event(command.SessionId, "item.started", _activeTurnId, itemId: "item-1", configure: appServerControlEvent =>
            {
                appServerControlEvent.Item = new AppServerControlProviderItemPayload
                {
                    ItemType = "tool",
                    Status = "running",
                    Title = "exec_command",
                    Detail = "rg --files"
                };
            }),
            Event(command.SessionId, "item.completed", _activeTurnId, itemId: "item-1", configure: appServerControlEvent =>
            {
                appServerControlEvent.Item = new AppServerControlProviderItemPayload
                {
                    ItemType = "tool",
                    Status = "completed",
                    Title = "exec_command",
                    Detail = "Workspace indexed"
                };
            }),
            Event(command.SessionId, "diff.updated", _activeTurnId, configure: appServerControlEvent =>
            {
                appServerControlEvent.DiffUpdated = new AppServerControlProviderDiffUpdatedPayload
                {
                    UnifiedDiff = "--- a/file.txt\n+++ b/file.txt\n@@\n-old\n+new\n"
                };
            }),
            Event(command.SessionId, "request.opened", _activeTurnId, requestId: _pendingRequestId, configure: appServerControlEvent =>
            {
                appServerControlEvent.RequestOpened = new AppServerControlProviderRequestOpenedPayload
                {
                    RequestType = "approval",
                    RequestTypeLabel = "Approval",
                    Detail = "Apply workspace patch?"
                };
            })
        ];
    }

    private List<AppServerControlProviderEvent> InterruptTurn(AppServerControlHostCommandEnvelope command)
    {
        return
        [
            Event(command.SessionId, "turn.aborted", _activeTurnId, configure: appServerControlEvent =>
            {
                appServerControlEvent.TurnCompleted = new AppServerControlProviderTurnCompletedPayload
                {
                    State = "aborted",
                    StateLabel = "Aborted",
                    StopReason = "interrupt"
                };
            })
        ];
    }

    private List<AppServerControlProviderEvent> ResolveRequest(AppServerControlHostCommandEnvelope command)
    {
        var requestId = command.ResolveRequest?.RequestId ?? _pendingRequestId ?? "req-approval-1";
        _pendingRequestId = null;
        return
        [
            Event(command.SessionId, "request.resolved", _activeTurnId, requestId: requestId, configure: appServerControlEvent =>
            {
                appServerControlEvent.RequestResolved = new AppServerControlProviderRequestResolvedPayload
                {
                    RequestType = "approval",
                    Decision = command.ResolveRequest?.Decision ?? "accept"
                };
            })
        ];
    }

    private List<AppServerControlProviderEvent> ResolveUserInput(AppServerControlHostCommandEnvelope command)
    {
        var requestId = command.ResolveUserInput?.RequestId ?? "req-user-input-1";
        return
        [
            Event(command.SessionId, "user-input.resolved", _activeTurnId, requestId: requestId, configure: appServerControlEvent =>
            {
                appServerControlEvent.UserInputResolved = new AppServerControlProviderUserInputResolvedPayload
                {
                    Answers = command.ResolveUserInput?.Answers ?? []
                };
            })
        ];
    }

    private AppServerControlProviderEvent Event(
        string sessionId,
        string type,
        string? turnId = null,
        string? itemId = null,
        string? requestId = null,
        Action<AppServerControlProviderEvent>? configure = null)
    {
        var nextSequence = Interlocked.Increment(ref _sequence);
        var appServerControlEvent = new AppServerControlProviderEvent
        {
            Sequence = nextSequence,
            EventId = $"evt-{nextSequence.ToString(CultureInfo.InvariantCulture)}",
            SessionId = sessionId,
            Provider = _provider,
            ThreadId = _threadId ?? "thread-synthetic",
            TurnId = turnId,
            ItemId = itemId,
            RequestId = requestId,
            CreatedAt = DateTimeOffset.UtcNow,
            Type = type,
            Raw = new AppServerControlProviderEventRaw
            {
                Source = "synthetic",
                Method = type
            }
        };

        configure?.Invoke(appServerControlEvent);
        return appServerControlEvent;
    }
}












