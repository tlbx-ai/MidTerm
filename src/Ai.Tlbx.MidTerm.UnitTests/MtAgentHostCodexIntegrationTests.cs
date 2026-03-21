using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class MtAgentHostCodexIntegrationTests
{
    [Fact]
    public async Task MtAgentHost_CanDriveFakeCodexAttachTurnApprovalAndAttachments()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var hostDll = ResolveAgentHostDll();
        var imagePath = Path.Combine(fakeCodex.Root, "sample.png");
        await File.WriteAllBytesAsync(imagePath, [1, 2, 3, 4]);
        var filePath = Path.Combine(fakeCodex.Root, "notes.txt");
        await File.WriteAllTextAsync(filePath, "attached text file");

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Equal(LensHostProtocol.CurrentVersion, hello.ProtocolVersion);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = "session-1",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-1",
                    Provider = "codex",
                    WorkingDirectory = fakeCodex.Root
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach");
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = (await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4)).ToList();
            if (!attachEvents.Any(envelope => envelope.Event.Type == "thread.started"))
            {
                attachEvents.Add(await LensHostTestClient.ReadEventAsync(process.StandardOutput, pendingEvents));
            }
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "session.started");
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "session.ready");
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "thread.started");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn",
                SessionId = "session-1",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Inspect attachments and ask approval.",
                    Attachments =
                    [
                        new LensAttachmentReference { Kind = "file", Path = filePath },
                        new LensAttachmentReference { Kind = "image", Path = imagePath, MimeType = "image/png" }
                    ]
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn");
            Assert.Equal("accepted", turnResult.Status);
            Assert.NotNull(turnResult.TurnStarted);
            Assert.Equal("codex", turnResult.TurnStarted!.Provider);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "request.opened",
                maxEvents: 12);
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.started");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "diff.updated");
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.StreamKind == "assistant_text" &&
                            envelope.Event.ContentDelta.Delta.Contains("images=1", StringComparison.Ordinal));
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.Delta.Contains("filerefs=true", StringComparison.OrdinalIgnoreCase) == true);
            var requestEvent = Assert.Single(turnEvents, envelope => envelope.Event.Type == "request.opened");
            Assert.Equal("command_execution_approval", requestEvent.Event.RequestOpened?.RequestType);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-resolve",
                SessionId = "session-1",
                Type = "request.resolve",
                ResolveRequest = new LensRequestResolutionCommand
                {
                    RequestId = requestEvent.Event.RequestId!,
                    Decision = "accept"
                }
            });

            var resolveResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-resolve");
            Assert.Equal("accepted", resolveResult.Status);

            var resolveEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 4);
            Assert.Contains(resolveEvents, envelope => envelope.Event.Type == "request.resolved");
            Assert.Contains(resolveEvents, envelope => envelope.Event.Type == "turn.completed");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
        }
    }

    [Fact]
    public async Task MtAgentHost_CanDriveFakeCodexUserInputFlow()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = "session-user-input",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-user-input",
                    Provider = "codex",
                    WorkingDirectory = fakeCodex.Root
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-user",
                SessionId = "session-user-input",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Inspect the repo and ask user for the mode.",
                    Attachments = []
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-user");
            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.requested",
                maxEvents: 12);
            var userInputEvent = Assert.Single(turnEvents, envelope => envelope.Event.Type == "user-input.requested");
            Assert.Equal("choice", Assert.Single(userInputEvent.Event.UserInputRequested!.Questions).Id);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-user-answer",
                SessionId = "session-user-input",
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = userInputEvent.Event.RequestId!,
                    Answers =
                    [
                        new LensPulseAnsweredQuestion
                        {
                            QuestionId = "choice",
                            Answers = ["Safe"]
                        }
                    ]
                }
            });

            var resolveResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-user-answer");
            Assert.Equal("accepted", resolveResult.Status);

            var resolveEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 6);
            Assert.Contains(resolveEvents, envelope => envelope.Event.Type == "user-input.resolved");
            Assert.Contains(resolveEvents, envelope => envelope.Event.Type == "item.completed");
            Assert.Contains(resolveEvents, envelope => envelope.Event.Type == "turn.completed");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
        }
    }

    [Fact]
    public async Task MtAgentHost_CanAttachToExistingCodexWebSocketRuntime()
    {
        await using var fakeServer = FakeCodexWebSocketServer.Start(
            loadedThreadId: "thread-remote-1",
            assistantReply: "Remote Codex shared-runtime reply.");
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-remote",
                SessionId = "session-remote",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-remote",
                    Provider = "codex",
                    WorkingDirectory = AppContext.BaseDirectory,
                    AttachPoint = new SessionAgentAttachPoint
                    {
                        Provider = SessionAgentAttachPoint.CodexProvider,
                        TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                        Endpoint = fakeServer.Endpoint,
                        SharedRuntime = true,
                        Source = "test",
                        PreferredThreadId = "thread-remote-1"
                    },
                    ResumeThreadId = "thread-remote-1"
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-remote");
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = (await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4)).ToList();
            if (!attachEvents.Any(envelope => envelope.Event.Type == "thread.started"))
            {
                attachEvents.Add(await LensHostTestClient.ReadEventAsync(process.StandardOutput, pendingEvents));
            }
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "thread.started");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-remote",
                SessionId = "session-remote",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Continue from the shared thread.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-remote");
            Assert.Equal("accepted", turnResult.Status);
            Assert.Equal("thread-remote-1", turnResult.TurnStarted!.ThreadId);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 8);
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.Delta == "Remote Codex shared-runtime reply.");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
        }
    }

    [Fact]
    public async Task MtAgentHost_CanInterruptFakeCodexTurn()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            _ = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = "session-interrupt",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-interrupt",
                    Provider = "codex",
                    WorkingDirectory = fakeCodex.Root
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-interrupt",
                SessionId = "session-interrupt",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Run a turn that will be interrupted.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-interrupt");
            Assert.Equal("accepted", turnResult.Status);
            Assert.NotNull(turnResult.TurnStarted);

            var turnStartedEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.started",
                maxEvents: 6);
            var startedEvent = Assert.Single(turnStartedEvents, envelope => envelope.Event.Type == "turn.started");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-stop",
                SessionId = "session-interrupt",
                Type = "turn.interrupt",
                InterruptTurn = new LensInterruptRequest
                {
                    TurnId = startedEvent.Event.TurnId
                }
            });

            var interruptResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-stop");
            Assert.Equal("accepted", interruptResult.Status);

            var interruptEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.aborted",
                maxEvents: 20);
            Assert.Contains(
                interruptEvents,
                envelope => envelope.Event.Type == "turn.aborted" &&
                            string.Equals(envelope.Event.TurnCompleted?.StopReason, "interrupt", StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
        }
    }

    private static Process StartAgentHost(string hostDll)
    {
        var dotnetHost = ResolveDotNetHostPath();
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = dotnetHost,
                Arguments = $"\"{hostDll}\" --stdio",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };
        process.Start();
        return process;
    }

    private static string ResolveDotNetHostPath()
    {
        var dotnetHost = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        if (!string.IsNullOrWhiteSpace(dotnetHost) && File.Exists(dotnetHost))
        {
            return dotnetHost;
        }

        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath) &&
            string.Equals(Path.GetFileNameWithoutExtension(processPath), "dotnet", StringComparison.OrdinalIgnoreCase))
        {
            return processPath;
        }

        return "dotnet";
    }

    private static string ResolveAgentHostDll()
    {
        var repoRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        var candidates = new[]
        {
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "mtagenthost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "Ai.Tlbx.MidTerm.AgentHost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "mtagenthost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "Ai.Tlbx.MidTerm.AgentHost.dll")
        };

        return candidates.First(File.Exists);
    }
}
