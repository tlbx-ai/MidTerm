using System.Globalization;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class SyntheticLensAgentRuntime : ILensAgentRuntime
{
    private readonly string _provider;
    private long _sequence;
    private string? _threadId;
    private string? _activeTurnId;
    private string? _pendingRequestId;

    public SyntheticLensAgentRuntime(string provider, Action<LensProviderEvent> emit)
    {
        _provider = provider;
    }

    public string Provider => _provider;

    public ValueTask DisposeAsync()
    {
        return ValueTask.CompletedTask;
    }

    public Task<HostCommandOutcome> ExecuteAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        List<LensProviderEvent> events = command.Type switch
        {
            "runtime.attach" => AttachRuntime(command),
            "turn.start" => StartTurn(command),
            "turn.interrupt" => InterruptTurn(command),
            "request.resolve" => ResolveRequest(command),
            "user-input.resolve" => ResolveUserInput(command),
            _ => throw new InvalidOperationException($"Unknown synthetic command type '{command.Type}'.")
        };

        var result = new LensHostCommandResultEnvelope
        {
            CommandId = command.CommandId,
            SessionId = command.SessionId,
            Status = "accepted",
            Accepted = new LensCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                RequestId = _pendingRequestId,
                TurnId = _activeTurnId
            }
        };

        if (command.Type == "turn.start")
        {
            result.TurnStarted = new LensTurnStartResponse
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

    private List<LensProviderEvent> AttachRuntime(LensHostCommandEnvelope command)
    {
        _threadId = command.AttachRuntime?.ResumeThreadId ?? "thread-synthetic";
        return
        [
            Event(command.SessionId, "session.started", configure: lensEvent =>
            {
                lensEvent.SessionState = new LensProviderSessionStatePayload
                {
                    State = "starting",
                    StateLabel = "Starting"
                };
            }),
            Event(command.SessionId, "session.ready", configure: lensEvent =>
            {
                lensEvent.SessionState = new LensProviderSessionStatePayload
                {
                    State = "ready",
                    StateLabel = "Ready"
                };
            }),
            Event(command.SessionId, "thread.started", configure: lensEvent =>
            {
                lensEvent.ThreadState = new LensProviderThreadStatePayload
                {
                    State = "active",
                    StateLabel = "Active",
                    ProviderThreadId = _threadId
                };
            })
        ];
    }

    private List<LensProviderEvent> StartTurn(LensHostCommandEnvelope command)
    {
        _threadId ??= "thread-synthetic";
        _activeTurnId = string.Create(CultureInfo.InvariantCulture, $"turn-{_sequence + 1}");
        _pendingRequestId = "req-approval-1";

        return
        [
            Event(command.SessionId, "turn.started", _activeTurnId, configure: lensEvent =>
            {
                lensEvent.TurnStarted = new LensProviderTurnStartedPayload
                {
                    Model = command.StartTurn?.Model ?? $"{_provider}-synthetic",
                    Effort = command.StartTurn?.Effort ?? "medium"
                };
            }),
            Event(command.SessionId, "content.delta", _activeTurnId, configure: lensEvent =>
            {
                lensEvent.ContentDelta = new LensProviderContentDeltaPayload
                {
                    StreamKind = "assistant_text",
                    Delta = $"Synthetic {_provider} reply for: {command.StartTurn?.Text ?? "(empty)"}"
                };
            }),
            Event(command.SessionId, "content.delta", _activeTurnId, configure: lensEvent =>
            {
                lensEvent.ContentDelta = new LensProviderContentDeltaPayload
                {
                    StreamKind = "reasoning_text",
                    Delta = "Inspecting workspace and shaping the next step."
                };
            }),
            Event(command.SessionId, "plan.completed", _activeTurnId, configure: lensEvent =>
            {
                lensEvent.PlanCompleted = new LensProviderPlanCompletedPayload
                {
                    PlanMarkdown = "1. Read the repo.\n2. Apply a focused patch.\n3. Verify the result."
                };
            }),
            Event(command.SessionId, "item.started", _activeTurnId, itemId: "item-1", configure: lensEvent =>
            {
                lensEvent.Item = new LensProviderItemPayload
                {
                    ItemType = "tool",
                    Status = "running",
                    Title = "exec_command",
                    Detail = "rg --files"
                };
            }),
            Event(command.SessionId, "item.completed", _activeTurnId, itemId: "item-1", configure: lensEvent =>
            {
                lensEvent.Item = new LensProviderItemPayload
                {
                    ItemType = "tool",
                    Status = "completed",
                    Title = "exec_command",
                    Detail = "Workspace indexed"
                };
            }),
            Event(command.SessionId, "diff.updated", _activeTurnId, configure: lensEvent =>
            {
                lensEvent.DiffUpdated = new LensProviderDiffUpdatedPayload
                {
                    UnifiedDiff = "--- a/file.txt\n+++ b/file.txt\n@@\n-old\n+new\n"
                };
            }),
            Event(command.SessionId, "request.opened", _activeTurnId, requestId: _pendingRequestId, configure: lensEvent =>
            {
                lensEvent.RequestOpened = new LensProviderRequestOpenedPayload
                {
                    RequestType = "approval",
                    RequestTypeLabel = "Approval",
                    Detail = "Apply workspace patch?"
                };
            })
        ];
    }

    private List<LensProviderEvent> InterruptTurn(LensHostCommandEnvelope command)
    {
        return
        [
            Event(command.SessionId, "turn.aborted", _activeTurnId, configure: lensEvent =>
            {
                lensEvent.TurnCompleted = new LensProviderTurnCompletedPayload
                {
                    State = "aborted",
                    StateLabel = "Aborted",
                    StopReason = "interrupt"
                };
            })
        ];
    }

    private List<LensProviderEvent> ResolveRequest(LensHostCommandEnvelope command)
    {
        var requestId = command.ResolveRequest?.RequestId ?? _pendingRequestId ?? "req-approval-1";
        _pendingRequestId = null;
        return
        [
            Event(command.SessionId, "request.resolved", _activeTurnId, requestId: requestId, configure: lensEvent =>
            {
                lensEvent.RequestResolved = new LensProviderRequestResolvedPayload
                {
                    RequestType = "approval",
                    Decision = command.ResolveRequest?.Decision ?? "accept"
                };
            })
        ];
    }

    private List<LensProviderEvent> ResolveUserInput(LensHostCommandEnvelope command)
    {
        var requestId = command.ResolveUserInput?.RequestId ?? "req-user-input-1";
        return
        [
            Event(command.SessionId, "user-input.resolved", _activeTurnId, requestId: requestId, configure: lensEvent =>
            {
                lensEvent.UserInputResolved = new LensProviderUserInputResolvedPayload
                {
                    Answers = command.ResolveUserInput?.Answers ?? []
                };
            })
        ];
    }

    private LensProviderEvent Event(
        string sessionId,
        string type,
        string? turnId = null,
        string? itemId = null,
        string? requestId = null,
        Action<LensProviderEvent>? configure = null)
    {
        var nextSequence = Interlocked.Increment(ref _sequence);
        var lensEvent = new LensProviderEvent
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
            Raw = new LensProviderEventRaw
            {
                Source = "synthetic",
                Method = type
            }
        };

        configure?.Invoke(lensEvent);
        return lensEvent;
    }
}












