using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class LensHostProtocolTests
{
    [Fact]
    public void LensHostCommandEnvelope_RoundTripsCanonicalTurnRequest()
    {
        var command = new LensHostCommandEnvelope
        {
            ProtocolVersion = LensHostProtocol.CurrentVersion,
            CommandId = "cmd-1",
            SessionId = "session-1",
            Type = "turn.start",
            StartTurn = new LensTurnRequest
            {
                Text = "Inspect the diff and continue.",
                Model = "gpt-5.3-codex",
                Effort = "medium",
                PlanMode = LensQuickSettings.PlanModeOn,
                PermissionMode = LensQuickSettings.PermissionModeAuto,
                Attachments =
                [
                    new LensAttachmentReference
                    {
                        Kind = "image",
                        Path = "Q:/repo/.midterm/uploads/screen.png",
                        MimeType = "image/png",
                        DisplayName = "screen.png"
                    }
                ]
            }
        };

        var json = JsonSerializer.Serialize(command, LensHostJsonContext.Default.LensHostCommandEnvelope);
        var roundTrip = JsonSerializer.Deserialize(json, LensHostJsonContext.Default.LensHostCommandEnvelope);

        Assert.NotNull(roundTrip);
        Assert.Equal(LensHostProtocol.CurrentVersion, roundTrip!.ProtocolVersion);
        Assert.Equal("turn.start", roundTrip.Type);
        Assert.NotNull(roundTrip.StartTurn);
        Assert.Equal("Inspect the diff and continue.", roundTrip.StartTurn!.Text);
        Assert.Equal("gpt-5.3-codex", roundTrip.StartTurn.Model);
        Assert.Equal(LensQuickSettings.PlanModeOn, roundTrip.StartTurn.PlanMode);
        Assert.Equal(LensQuickSettings.PermissionModeAuto, roundTrip.StartTurn.PermissionMode);
        Assert.Single(roundTrip.StartTurn.Attachments);
        Assert.Equal("image", roundTrip.StartTurn.Attachments[0].Kind);
        Assert.Equal("Q:/repo/.midterm/uploads/screen.png", roundTrip.StartTurn.Attachments[0].Path);
    }

    [Fact]
    public void LensHostCommandEnvelope_RoundTripsAttachPointMetadata()
    {
        var command = new LensHostCommandEnvelope
        {
            ProtocolVersion = LensHostProtocol.CurrentVersion,
            CommandId = "cmd-attach-remote",
            SessionId = "session-remote-1",
            Type = "runtime.attach",
            AttachRuntime = new LensAttachRuntimeRequest
            {
                SessionId = "session-remote-1",
                Provider = "codex",
                WorkingDirectory = "Q:/repo",
                AttachPoint = new SessionAgentAttachPoint
                {
                    Provider = SessionAgentAttachPoint.CodexProvider,
                    TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                    Endpoint = "ws://127.0.0.1:4513/",
                    SharedRuntime = true,
                    Source = "foreground-command-line.remote",
                    PreferredThreadId = "thread-abc123"
                }
            }
        };

        var json = JsonSerializer.Serialize(command, LensHostJsonContext.Default.LensHostCommandEnvelope);
        var roundTrip = JsonSerializer.Deserialize(json, LensHostJsonContext.Default.LensHostCommandEnvelope);

        Assert.NotNull(roundTrip);
        Assert.NotNull(roundTrip!.AttachRuntime);
        Assert.NotNull(roundTrip.AttachRuntime!.AttachPoint);
        Assert.Equal("ws://127.0.0.1:4513/", roundTrip.AttachRuntime.AttachPoint!.Endpoint);
        Assert.Equal("thread-abc123", roundTrip.AttachRuntime.AttachPoint.PreferredThreadId);
    }

    [Fact]
    public void SyntheticLensHostFlow_ProducesCanonicalSnapshotThroughIngress()
    {
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var host = new SyntheticLensAgentHost();

        ingress.ValidateHello(host.Hello);

        var attachResult = host.Handle(new LensHostCommandEnvelope
        {
            ProtocolVersion = LensHostProtocol.CurrentVersion,
            CommandId = "cmd-attach",
            SessionId = "session-1",
            Type = "runtime.attach",
            AttachRuntime = new LensAttachRuntimeRequest
            {
                SessionId = "session-1",
                Provider = "codex",
                WorkingDirectory = "Q:/repo"
            }
        });
        ingress.ApplyEvents(attachResult.Events);

        var turnResult = host.Handle(new LensHostCommandEnvelope
        {
            ProtocolVersion = LensHostProtocol.CurrentVersion,
            CommandId = "cmd-turn",
            SessionId = "session-1",
            Type = "turn.start",
            StartTurn = new LensTurnRequest
            {
                Text = "Continue with the implementation."
            }
        });
        ingress.ApplyEvents(turnResult.Events);

        var resolveResult = host.Handle(new LensHostCommandEnvelope
        {
            ProtocolVersion = LensHostProtocol.CurrentVersion,
            CommandId = "cmd-resolve",
            SessionId = "session-1",
            Type = "request.resolve",
            ResolveRequest = new LensRequestResolutionCommand
            {
                RequestId = "approval-1",
                Decision = "accept"
            }
        });
        ingress.ApplyEvents(resolveResult.Events);

        var snapshot = pulse.GetSnapshot("session-1");

        Assert.NotNull(snapshot);
        Assert.Equal("codex", snapshot!.Provider);
        Assert.Equal("ready", snapshot.Session.State);
        Assert.Equal("Active", snapshot.Thread.StateLabel);
        Assert.Equal("turn-1", snapshot.CurrentTurn.TurnId);
        Assert.Equal("Assistant says hi.", snapshot.Streams.AssistantText);
        Assert.Equal("Thinking hard.", snapshot.Streams.ReasoningText);
        Assert.Equal("1. inspect\n2. patch", snapshot.Streams.PlanText);
        Assert.Equal("dotnet test", snapshot.Streams.CommandOutput);
        Assert.Equal("--- a/app.cs\n+++ b/app.cs", snapshot.Streams.UnifiedDiff);
        Assert.Equal("gpt-5.3-codex", snapshot.QuickSettings.Model);
        Assert.Equal("medium", snapshot.QuickSettings.Effort);
        Assert.Equal(LensQuickSettings.PlanModeOn, snapshot.QuickSettings.PlanMode);
        Assert.Equal(LensQuickSettings.PermissionModeManual, snapshot.QuickSettings.PermissionMode);
        Assert.Contains(snapshot.Requests, request => request.RequestId == "approval-1" && request.Decision == "accept");
    }

    private sealed class SyntheticLensAgentHost
    {
        public LensHostHello Hello { get; } = new()
        {
            ProtocolVersion = LensHostProtocol.CurrentVersion,
            HostKind = "mtagenthost",
            HostVersion = "synthetic",
            Providers = ["codex", "claude"],
            Capabilities = ["attach", "turn.start", "request.resolve"]
        };

        public SyntheticCommandResult Handle(LensHostCommandEnvelope command)
        {
            return command.Type switch
            {
                "runtime.attach" => Attach(command),
                "turn.start" => StartTurn(command),
                "request.resolve" => ResolveRequest(command),
                _ => throw new InvalidOperationException($"Unsupported synthetic command '{command.Type}'.")
            };
        }

        private static SyntheticCommandResult Attach(LensHostCommandEnvelope command)
        {
            return new SyntheticCommandResult(
                new LensHostCommandResultEnvelope
                {
                    ProtocolVersion = LensHostProtocol.CurrentVersion,
                    CommandId = command.CommandId,
                    SessionId = command.SessionId,
                    Status = "accepted",
                    Accepted = new LensCommandAcceptedResponse
                    {
                        SessionId = command.SessionId,
                        Status = "accepted"
                    }
                },
                [
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-attach-1",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:00Z"),
                        Type = "session.started",
                        SessionState = new LensPulseSessionStatePayload
                        {
                            State = "starting",
                            StateLabel = "Starting",
                            Reason = "Synthetic attach"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-attach-2",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:01Z"),
                        Type = "thread.started",
                        ThreadState = new LensPulseThreadStatePayload
                        {
                            State = "active",
                            StateLabel = "Active",
                            ProviderThreadId = "thread-1"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-attach-3",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:02Z"),
                        Type = "session.ready",
                        SessionState = new LensPulseSessionStatePayload
                        {
                            State = "ready",
                            StateLabel = "Ready",
                            Reason = "Synthetic host attached"
                        }
                    })
                ]);
        }

        private static SyntheticCommandResult StartTurn(LensHostCommandEnvelope command)
        {
            return new SyntheticCommandResult(
                new LensHostCommandResultEnvelope
                {
                    ProtocolVersion = LensHostProtocol.CurrentVersion,
                    CommandId = command.CommandId,
                    SessionId = command.SessionId,
                    Status = "accepted",
                    TurnStarted = new LensTurnStartResponse
                    {
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        Status = "accepted",
                        QuickSettings = new LensQuickSettingsSummary
                        {
                            Model = "gpt-5.3-codex",
                            Effort = "medium",
                            PlanMode = LensQuickSettings.PlanModeOn,
                            PermissionMode = LensQuickSettings.PermissionModeManual
                        }
                    }
                },
                [
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-settings-1",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:02.5000000Z"),
                        Type = "quick-settings.updated",
                        QuickSettingsUpdated = new LensPulseQuickSettingsPayload
                        {
                            Model = "gpt-5.3-codex",
                            Effort = "medium",
                            PlanMode = LensQuickSettings.PlanModeOn,
                            PermissionMode = LensQuickSettings.PermissionModeManual
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-1",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:03Z"),
                        Type = "turn.started",
                        TurnStarted = new LensPulseTurnStartedPayload
                        {
                            Model = "gpt-5.3-codex",
                            Effort = "medium"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-2",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        ItemId = "item-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:04Z"),
                        Type = "content.delta",
                        ContentDelta = new LensPulseContentDeltaPayload
                        {
                            StreamKind = "assistant_text",
                            Delta = "Assistant says hi."
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-3",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        ItemId = "item-2",
                        CreatedAt = ParseUtc("2026-03-20T15:00:05Z"),
                        Type = "content.delta",
                        ContentDelta = new LensPulseContentDeltaPayload
                        {
                            StreamKind = "reasoning_text",
                            Delta = "Thinking hard."
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-4",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:06Z"),
                        Type = "plan.completed",
                        PlanCompleted = new LensPulsePlanCompletedPayload
                        {
                            PlanMarkdown = "1. inspect\n2. patch"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-5",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        ItemId = "tool-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:07Z"),
                        Type = "content.delta",
                        ContentDelta = new LensPulseContentDeltaPayload
                        {
                            StreamKind = "command_output",
                            Delta = "dotnet test"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-6",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:08Z"),
                        Type = "diff.updated",
                        DiffUpdated = new LensPulseDiffUpdatedPayload
                        {
                            UnifiedDiff = "--- a/app.cs\n+++ b/app.cs"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-7",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        RequestId = "approval-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:09Z"),
                        Type = "request.opened",
                        RequestOpened = new LensPulseRequestOpenedPayload
                        {
                            RequestType = "command_execution_approval",
                            RequestTypeLabel = "Command approval",
                            Detail = "Run dotnet test"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-8",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:10Z"),
                        Type = "turn.completed",
                        TurnCompleted = new LensPulseTurnCompletedPayload
                        {
                            State = "completed",
                            StateLabel = "Completed"
                        }
                    }),
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-turn-9",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        CreatedAt = ParseUtc("2026-03-20T15:00:11Z"),
                        Type = "session.state.changed",
                        SessionState = new LensPulseSessionStatePayload
                        {
                            State = "ready",
                            StateLabel = "Ready",
                            Reason = "Turn completed"
                        }
                    })
                ]);
        }

        private static SyntheticCommandResult ResolveRequest(LensHostCommandEnvelope command)
        {
            return new SyntheticCommandResult(
                new LensHostCommandResultEnvelope
                {
                    ProtocolVersion = LensHostProtocol.CurrentVersion,
                    CommandId = command.CommandId,
                    SessionId = command.SessionId,
                    Status = "accepted",
                    Accepted = new LensCommandAcceptedResponse
                    {
                        SessionId = command.SessionId,
                        Status = "accepted",
                        RequestId = command.ResolveRequest?.RequestId
                    }
                },
                [
                    Envelope(command.SessionId, new LensPulseEvent
                    {
                        EventId = "evt-resolve-1",
                        SessionId = command.SessionId,
                        Provider = "codex",
                        ThreadId = "thread-1",
                        TurnId = "turn-1",
                        RequestId = command.ResolveRequest!.RequestId,
                        CreatedAt = ParseUtc("2026-03-20T15:00:12Z"),
                        Type = "request.resolved",
                        RequestResolved = new LensPulseRequestResolvedPayload
                        {
                            RequestType = "command_execution_approval",
                            Decision = command.ResolveRequest.Decision
                        }
                    })
                ]);
        }

        private static LensHostEventEnvelope Envelope(string sessionId, LensPulseEvent lensEvent)
        {
            return new LensHostEventEnvelope
            {
                ProtocolVersion = LensHostProtocol.CurrentVersion,
                SessionId = sessionId,
                Event = lensEvent
            };
        }
    }

    private static DateTimeOffset ParseUtc(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture);

    private sealed record SyntheticCommandResult(
        LensHostCommandResultEnvelope Result,
        IReadOnlyList<LensHostEventEnvelope> Events);
}

