using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class SessionLensHostRuntimeServiceTests
{
    private static SettingsService CreateSettingsService() => new();
    private static SettingsService CreateSettingsService(string directory) => new(directory);

    [Fact]
    public async Task SessionLensRuntimeService_CanDelegateToMtAgentHostSyntheticMode()
    {
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "synthetic");
        await using var sessionManager = new TtyHostSessionManager();
        var profileService = new AiCliProfileService();
        await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

        var session = new SessionInfoDto
        {
            Id = "session-runtime-1",
            CurrentDirectory = AppContext.BaseDirectory,
            ForegroundName = "codex"
        };

        var attached = await runtime.EnsureAttachedAsync(session.Id, session);
        Assert.True(attached);
        Assert.True(runtime.IsAttached(session.Id));
        Assert.NotNull(pulse.GetSnapshot(session.Id));

        var turn = await runtime.StartTurnAsync(
            session.Id,
            new LensTurnRequest
            {
                Text = "Inspect the workspace.",
                Attachments = []
            });

        Assert.Equal("codex", turn.Provider);
        Assert.Equal("started", turn.Status);

        var resolved = await runtime.ResolveRequestAsync(
            session.Id,
            "req-approval-1",
            new LensRequestDecisionRequest
            {
                Decision = "accept"
            });

        Assert.Equal("accepted", resolved.Status);

        var events = await WaitForEventsAsync(
            pulse,
            session.Id,
            current => current.Events.Any(lensEvent => lensEvent.Type == "request.resolved"));
        Assert.Contains(events.Events, lensEvent => lensEvent.Type == "session.ready");
        Assert.Contains(events.Events, lensEvent => lensEvent.Type == "turn.started");
        Assert.Contains(events.Events, lensEvent => lensEvent.Type == "request.opened");
        Assert.Contains(events.Events, lensEvent => lensEvent.Type == "request.resolved");

        var snapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => current.Requests.Any(request => request.Kind == "approval" && request.Decision == "accept"));
        Assert.NotNull(snapshot);
        Assert.Equal("codex", snapshot!.Provider);
        Assert.Equal("Synthetic codex reply for: Inspect the workspace.", snapshot.Streams.AssistantText);
        Assert.Contains(snapshot.Requests, request => request.Kind == "approval" && request.Decision == "accept");

        Assert.True(runtime.TryGetSnapshot(session.Id, out var runtimeSnapshot));
        Assert.Equal("mtagenthost-stdio", runtimeSnapshot.TransportKey);
        Assert.Equal("running", runtimeSnapshot.Status);
        Assert.Equal("Synthetic codex reply for: Inspect the workspace.", runtimeSnapshot.AssistantText);
    }

    [Fact]
    public async Task SessionLensRuntimeService_CanDelegateToMtAgentHostCodexMode()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "codex");
        await using var sessionManager = new TtyHostSessionManager();
        var profileService = new AiCliProfileService();
        await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

        var imagePath = Path.Combine(fakeCodex.Root, "sample.png");
        await File.WriteAllBytesAsync(imagePath, [1, 2, 3, 4]);

        var session = new SessionInfoDto
        {
            Id = "session-runtime-codex-1",
            CurrentDirectory = fakeCodex.Root,
            ForegroundName = "codex"
        };

        var attached = await runtime.EnsureAttachedAsync(session.Id, session);
        Assert.True(attached);
        Assert.True(runtime.IsAttached(session.Id));
        Assert.NotNull(pulse.GetSnapshot(session.Id));

        var turn = await runtime.StartTurnAsync(
            session.Id,
            new LensTurnRequest
            {
                Text = "Inspect attachments and ask approval.",
                Attachments =
                [
                    new LensAttachmentReference
                    {
                        Kind = "image",
                        Path = imagePath,
                        MimeType = "image/png"
                    }
                ]
            });

        Assert.Equal("codex", turn.Provider);
        Assert.Equal("accepted", turn.Status);

        var requestSnapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => current.Requests.Any(request => request.Kind == "command_execution_approval" && request.State == "open"));
        Assert.NotNull(requestSnapshot);
        var pendingRequest = Assert.Single(requestSnapshot!.Requests, request => request.Kind == "command_execution_approval" && request.State == "open");

        var resolved = await runtime.ResolveRequestAsync(
            session.Id,
            pendingRequest.RequestId,
            new LensRequestDecisionRequest
            {
                Decision = "accept"
            });

        Assert.Equal("accepted", resolved.Status);

        var snapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => current.CurrentTurn.State == "completed" &&
                       current.Requests.Any(request => request.Kind == "command_execution_approval" && request.Decision == "accept"));
        Assert.NotNull(snapshot);
        Assert.Contains("images=1", snapshot!.Streams.AssistantText, StringComparison.Ordinal);
        Assert.Contains(snapshot.Requests, request => request.Kind == "command_execution_approval" && request.Decision == "accept");
        Assert.Contains(
            snapshot.Items,
            item => item.ItemType == "user_message" &&
                    item.Attachments.Count == 1 &&
                    string.Equals(item.Attachments[0].DisplayName, "sample.png", StringComparison.Ordinal));

        Assert.True(runtime.TryGetSnapshot(session.Id, out var runtimeSnapshot));
        Assert.Equal("mtagenthost-stdio", runtimeSnapshot.TransportKey);
        Assert.Equal("ready", runtimeSnapshot.Status);
        Assert.Contains("images=1", runtimeSnapshot.AssistantText ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SessionLensRuntimeService_CanDelegateToMtAgentHostClaudeMode()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var settingsRoot = Path.Combine(Path.GetTempPath(), "midterm-lens-claude-settings-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(settingsRoot);
        var settingsService = CreateSettingsService(settingsRoot);
        var settings = settingsService.Load();
        settings.ClaudeDangerouslySkipPermissionsDefault = true;
        settings.ClaudeEnvironmentVariables = "FAKE_CLAUDE_ENV=applied";
        settingsService.Save(settings);

        try
        {
            var pulse = new SessionLensPulseService();
            var ingress = new SessionLensHostIngressService(pulse);
            var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, settingsService, mode: "codex");
            await using var sessionManager = new TtyHostSessionManager();
            var profileService = new AiCliProfileService();
            await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

            var attachmentPath = Path.Combine(fakeClaude.Root, "notes.txt");
            await File.WriteAllTextAsync(attachmentPath, "attached text file");

            var session = new SessionInfoDto
            {
                Id = "session-runtime-claude-1",
                CurrentDirectory = fakeClaude.Root,
                ForegroundName = "claude"
            };

            var attached = await runtime.EnsureAttachedAsync(session.Id, session);
            Assert.True(attached);
            Assert.True(runtime.IsAttached(session.Id));

            var firstTurn = await runtime.StartTurnAsync(
                session.Id,
                new LensTurnRequest
                {
                    Text = "Inspect the attached file.",
                    Attachments =
                    [
                        new LensAttachmentReference { Kind = "file", Path = attachmentPath }
                    ]
                });

            Assert.Equal("claude", firstTurn.Provider);
            Assert.Equal("accepted", firstTurn.Status);

            var firstSnapshot = await WaitForSnapshotAsync(
                pulse,
                session.Id,
                current => current.CurrentTurn.State == "completed" &&
                           current.Streams.AssistantText.Contains("attachments=1", StringComparison.Ordinal));
            Assert.NotNull(firstSnapshot);
            Assert.Equal("claude", firstSnapshot!.Provider);
            Assert.Contains("danger=true", firstSnapshot.Streams.AssistantText, StringComparison.Ordinal);
            Assert.Contains("env=applied", firstSnapshot.Streams.AssistantText, StringComparison.Ordinal);
            Assert.NotEmpty(firstSnapshot.Thread.ThreadId);

            var secondTurn = await runtime.StartTurnAsync(
                session.Id,
                new LensTurnRequest
                {
                    Text = "Continue in the same conversation.",
                    Attachments = []
                });

            Assert.Equal(firstSnapshot.Thread.ThreadId, secondTurn.ThreadId);

            var secondSnapshot = await WaitForSnapshotAsync(
                pulse,
                session.Id,
                current => current.CurrentTurn.State == "completed" &&
                           current.Streams.AssistantText.Contains("resumed=true", StringComparison.Ordinal));
            Assert.NotNull(secondSnapshot);

            Assert.True(runtime.TryGetSnapshot(session.Id, out var runtimeSnapshot));
            Assert.Equal("mtagenthost-stdio", runtimeSnapshot.TransportKey);
            Assert.Equal("mtagenthost claude stdio", runtimeSnapshot.TransportLabel);
        }
        finally
        {
            try
            {
                Directory.Delete(settingsRoot, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    public async Task SessionLensRuntimeService_KeepsExistingCodexLensAttachAfterTerminalReturnsToShell()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "codex");
        await using var sessionManager = new TtyHostSessionManager();
        var profileService = new AiCliProfileService();
        await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

        var sessionId = "session-runtime-codex-shell-return-1";
        var codexSession = new SessionInfoDto
        {
            Id = sessionId,
            CurrentDirectory = fakeCodex.Root,
            ForegroundName = "codex"
        };

        var attached = await runtime.EnsureAttachedAsync(sessionId, codexSession);
        Assert.True(attached);
        Assert.True(runtime.IsAttached(sessionId));

        var shellSession = new SessionInfoDto
        {
            Id = sessionId,
            CurrentDirectory = fakeCodex.Root,
            ForegroundName = "shell",
            ForegroundProcessIdentity = "shell"
        };

        var reusedAttach = await runtime.EnsureAttachedAsync(sessionId, shellSession);
        Assert.True(reusedAttach);

        var turn = await runtime.StartTurnAsync(
            sessionId,
            new LensTurnRequest
            {
                Text = "Confirm the reused attach still accepts turns.",
                Attachments = []
            });

        Assert.Equal("accepted", turn.Status);

        var snapshot = await WaitForSnapshotAsync(
            pulse,
            sessionId,
            current => string.Equals(current.CurrentTurn.State, "completed", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(snapshot);
        Assert.Contains("reused attach", snapshot!.Streams.AssistantText, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SessionLensRuntimeService_CanResolveMtAgentHostCodexUserInput()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "codex");
        await using var sessionManager = new TtyHostSessionManager();
        var profileService = new AiCliProfileService();
        await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

        var session = new SessionInfoDto
        {
            Id = "session-runtime-codex-user-1",
            CurrentDirectory = fakeCodex.Root,
            ForegroundName = "codex"
        };

        var attached = await runtime.EnsureAttachedAsync(session.Id, session);
        Assert.True(attached);
        Assert.NotNull(pulse.GetSnapshot(session.Id));

        _ = await runtime.StartTurnAsync(
            session.Id,
            new LensTurnRequest
            {
                Text = "Inspect the repo and ask user for the mode.",
                Attachments = []
            });

        var requestSnapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => current.Requests.Any(request => request.Kind == "tool_user_input" && request.State == "open"));
        Assert.NotNull(requestSnapshot);
        var pendingRequest = Assert.Single(requestSnapshot!.Requests, request => request.Kind == "tool_user_input" && request.State == "open");

        var resolved = await runtime.ResolveUserInputAsync(
            session.Id,
            pendingRequest.RequestId,
            new LensUserInputAnswerRequest
            {
                Answers =
                [
                    new LensPulseAnsweredQuestion
                    {
                        QuestionId = "choice",
                        Answers = ["Safe"]
                    }
                ]
            });

        Assert.Equal("accepted", resolved.Status);

        var snapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => current.CurrentTurn.State == "completed" &&
                       current.Requests.Any(request => request.Kind == "tool_user_input" &&
                                                       request.Answers.Any(answer => answer.QuestionId == "choice" &&
                                                                                    answer.Answers.Contains("Safe", StringComparer.Ordinal))));
        Assert.NotNull(snapshot);
        Assert.Contains(
            snapshot!.Requests,
            request => request.Kind == "tool_user_input" &&
                       request.Answers.Any(answer => answer.QuestionId == "choice" &&
                                                    answer.Answers.Contains("Safe", StringComparer.Ordinal)));
    }

    [Fact]
    public async Task SessionLensRuntimeService_CanInterruptMtAgentHostCodexTurn()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "codex");
        await using var sessionManager = new TtyHostSessionManager();
        var profileService = new AiCliProfileService();
        await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

        var session = new SessionInfoDto
        {
            Id = "session-runtime-codex-interrupt-1",
            CurrentDirectory = fakeCodex.Root,
            ForegroundName = "codex"
        };

        var attached = await runtime.EnsureAttachedAsync(session.Id, session);
        Assert.True(attached);
        Assert.NotNull(pulse.GetSnapshot(session.Id));

        _ = await runtime.StartTurnAsync(
            session.Id,
            new LensTurnRequest
            {
                Text = "Run a turn that will be interrupted.",
                Attachments = []
            });

        var startedSnapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => !string.IsNullOrWhiteSpace(current.CurrentTurn.TurnId) &&
                       string.Equals(current.CurrentTurn.State, "running", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(startedSnapshot);

        var interrupted = await runtime.InterruptTurnAsync(
            session.Id,
            new LensInterruptRequest
            {
                TurnId = startedSnapshot!.CurrentTurn.TurnId
            });

        Assert.Equal("accepted", interrupted.Status);

        var finalSnapshot = await WaitForSnapshotAsync(
            pulse,
            session.Id,
            current => string.Equals(current.CurrentTurn.State, "interrupted", StringComparison.OrdinalIgnoreCase));
        Assert.NotNull(finalSnapshot);
        Assert.Equal("Interrupted", finalSnapshot!.CurrentTurn.StateLabel);

        var events = await WaitForEventsAsync(
            pulse,
            session.Id,
            current => current.Events.Any(lensEvent => lensEvent.Type == "turn.aborted"));
        Assert.Contains(
            events.Events,
            lensEvent => lensEvent.Type == "turn.aborted" &&
                         string.Equals(lensEvent.TurnCompleted?.StopReason, "interrupt", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task SessionLensRuntimeService_CanAttachMtAgentHostCodexWithoutServicePath()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var originalPath = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            var pulse = new SessionLensPulseService();
            var ingress = new SessionLensHostIngressService(pulse);
            var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "codex");
            await using var sessionManager = new TtyHostSessionManager();
            var profileService = new AiCliProfileService();
            await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

            var session = new SessionInfoDto
            {
                Id = "session-runtime-codex-no-path-1",
                CurrentDirectory = fakeCodex.Root,
                ForegroundName = "codex",
                ForegroundCommandLine = $"\"{fakeCodex.ExecutablePath}\" --yolo"
            };

            var attached = await runtime.EnsureAttachedAsync(session.Id, session);

            Assert.True(attached);
            Assert.True(runtime.IsAttached(session.Id));
            Assert.NotNull(pulse.GetSnapshot(session.Id));
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", originalPath);
        }
    }

    [Fact]
    public async Task SessionLensRuntimeService_CanAttachToExistingCodexWebSocketWithoutSpawningCodex()
    {
        await using var fakeServer = FakeCodexWebSocketServer.Start(
            loadedThreadId: "thread-remote-1",
            assistantReply: "Remote Codex shared-runtime reply.");
        var originalPath = Environment.GetEnvironmentVariable("PATH");
        Environment.SetEnvironmentVariable("PATH", string.Empty);
        try
        {
            var pulse = new SessionLensPulseService();
            var ingress = new SessionLensHostIngressService(pulse);
            var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, CreateSettingsService(), mode: "codex");
            await using var sessionManager = new TtyHostSessionManager();
            var profileService = new AiCliProfileService();
            await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

            var session = new SessionInfoDto
            {
                Id = "session-runtime-codex-remote-1",
                CurrentDirectory = AppContext.BaseDirectory,
                ForegroundName = "codex",
                ForegroundCommandLine = $"codex --remote {fakeServer.Endpoint} resume thread-remote-1",
                AgentAttachPoint = new SessionAgentAttachPoint
                {
                    Provider = SessionAgentAttachPoint.CodexProvider,
                    TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                    Endpoint = fakeServer.Endpoint,
                    SharedRuntime = true,
                    Source = "test",
                    PreferredThreadId = "thread-remote-1"
                }
            };

            var attached = await runtime.EnsureAttachedAsync(session.Id, session);

            Assert.True(attached);
            Assert.True(runtime.IsAttached(session.Id));

            var turn = await runtime.StartTurnAsync(
                session.Id,
                new LensTurnRequest
                {
                    Text = "Continue from the existing thread.",
                    Attachments = []
                });

            Assert.Equal("accepted", turn.Status);
            Assert.Equal("thread-remote-1", turn.ThreadId);

            var snapshot = await WaitForSnapshotAsync(
                pulse,
                session.Id,
                current => string.Equals(current.CurrentTurn.State, "completed", StringComparison.OrdinalIgnoreCase));
            Assert.NotNull(snapshot);
            Assert.Equal("Remote Codex shared-runtime reply.", snapshot!.Streams.AssistantText);

            Assert.True(runtime.TryGetSnapshot(session.Id, out var runtimeSnapshot));
            Assert.Equal(SessionAgentAttachPoint.CodexAppServerWebSocketTransport, runtimeSnapshot.TransportKey);
            Assert.Equal("Codex app-server websocket", runtimeSnapshot.TransportLabel);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", originalPath);
        }
    }

    [Fact]
    public async Task SessionLensRuntimeService_FallsBackToLegacyCodexWhenMtAgentHostColdAttachThrows()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(
            ingress,
            pulse,
            CreateSettingsService(),
            instanceIdentity: null,
            mode: "codex",
            launcher: static (
                string _fileName,
                IReadOnlyList<string> _args,
                string _workingDirectory,
                IReadOnlyDictionary<string, string?>? _environmentOverrides,
                IReadOnlyList<string>? _pathPrependEntries,
                string? _runAsUser,
                out TtyHostSpawner.RedirectedProcessHandle? launchedProcess,
                out string? failure) =>
            {
                launchedProcess = null;
                failure = null;
                throw new InvalidOperationException("Injected mtagenthost cold-start failure.");
            });
        await using var sessionManager = new TtyHostSessionManager();
        var profileService = new AiCliProfileService();
        await using var runtime = new SessionLensRuntimeService(sessionManager, profileService, pulse, hostRuntime);

        var session = new SessionInfoDto
        {
            Id = "session-runtime-codex-host-fallback-1",
            CurrentDirectory = fakeCodex.Root,
            ForegroundName = "codex"
        };

        var attached = await runtime.EnsureAttachedAsync(session.Id, session);

        Assert.True(attached);
        Assert.True(runtime.IsAttached(session.Id));
        Assert.True(runtime.TryGetSnapshot(session.Id, out var runtimeSnapshot));
        Assert.Equal("codex-app-server", runtimeSnapshot.TransportKey);
        Assert.Equal("Codex app-server runtime", runtimeSnapshot.TransportLabel);
        Assert.Equal("ready", runtimeSnapshot.Status);

        var turn = await runtime.StartTurnAsync(
            session.Id,
            new LensTurnRequest
            {
                Text = "Confirm the fallback runtime keeps turn ids on transcript events.",
                Attachments = []
            });

        Assert.Equal("accepted", turn.Status);
        Assert.NotNull(turn.TurnId);

        var events = await WaitForEventsAsync(
            pulse,
            session.Id,
            current => current.Events.Any(lensEvent => lensEvent.Type == "content.delta"));

        Assert.Contains(
            events.Events,
            lensEvent => lensEvent.Type == "item.completed" &&
                         string.Equals(lensEvent.ItemId, $"local-user:{turn.TurnId}", StringComparison.Ordinal) &&
                         string.Equals(lensEvent.TurnId, turn.TurnId, StringComparison.Ordinal));
        Assert.Contains(
            events.Events,
            lensEvent => lensEvent.Type == "content.delta" &&
                         string.Equals(lensEvent.TurnId, turn.TurnId, StringComparison.Ordinal) &&
                         string.Equals(lensEvent.ContentDelta?.StreamKind, "assistant_text", StringComparison.Ordinal));
    }

    private static async Task<LensPulseEventListResponse> WaitForEventsAsync(
        SessionLensPulseService pulse,
        string sessionId,
        Func<LensPulseEventListResponse, bool> predicate)
    {
        for (var i = 0; i < 80; i++)
        {
            var events = pulse.GetEvents(sessionId);
            if (predicate(events))
            {
                return events;
            }

            await Task.Delay(25);
        }

        return pulse.GetEvents(sessionId);
    }

    private static async Task<LensPulseSnapshotResponse?> WaitForSnapshotAsync(
        SessionLensPulseService pulse,
        string sessionId,
        Func<LensPulseSnapshotResponse, bool> predicate)
    {
        for (var i = 0; i < 80; i++)
        {
            var snapshot = pulse.GetSnapshot(sessionId);
            if (snapshot is not null && predicate(snapshot))
            {
                return snapshot;
            }

            await Task.Delay(25);
        }

        return pulse.GetSnapshot(sessionId);
    }
}
