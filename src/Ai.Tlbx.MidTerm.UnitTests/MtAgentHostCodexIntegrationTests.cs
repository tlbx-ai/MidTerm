using System.Diagnostics;
using System.Text.Json;
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

            var turnEvents = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "request.opened",
                maxEvents: 40,
                timeout: TimeSpan.FromSeconds(10));
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
            var turnEvents = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.requested",
                maxEvents: 40,
                timeout: TimeSpan.FromSeconds(10));
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
    public async Task MtAgentHost_SpawnsFakeCodexAppServerWithExpectedColdAttachParameters()
    {
        var originalYoloDefault = Environment.GetEnvironmentVariable("MIDTERM_LENS_CODEX_YOLO_DEFAULT");
        Environment.SetEnvironmentVariable("MIDTERM_LENS_CODEX_YOLO_DEFAULT", "false");

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
                CommandId = "cmd-attach-cold-launch",
                SessionId = "session-cold-launch",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-cold-launch",
                    Provider = "codex",
                    WorkingDirectory = fakeCodex.Root
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-cold-launch");
            Assert.Equal("accepted", attachResult.Status);

            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            var capture = await WaitForFakeCodexLaunchCaptureAsync(
                fakeCodex.CapturePath,
                static launch => launch.Arguments.Length > 0 &&
                                 !string.IsNullOrWhiteSpace(launch.ThreadStartCwd));

            Assert.Equal(["app-server"], capture.Arguments);
            Assert.Equal(fakeCodex.Root, capture.ProcessWorkingDirectory);
            Assert.Contains("initialize", capture.Methods);
            Assert.Contains("initialized", capture.Methods);
            Assert.Contains("thread/start", capture.Methods);
            Assert.DoesNotContain("thread/resume", capture.Methods);
            Assert.Equal("midterm", capture.InitializeClientName);
            Assert.Equal("MidTerm Lens", capture.InitializeClientTitle);
            Assert.False(string.IsNullOrWhiteSpace(capture.InitializeClientVersion));
            Assert.True(capture.InitializeExperimentalApi);
            Assert.Equal(fakeCodex.Root, capture.ThreadStartCwd);
            Assert.Equal("on-request", capture.ThreadStartApprovalPolicy);
            Assert.Equal("workspace-write", capture.ThreadStartSandbox);
            Assert.False(capture.ThreadStartExperimentalRawEvents);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            Environment.SetEnvironmentVariable("MIDTERM_LENS_CODEX_YOLO_DEFAULT", originalYoloDefault);
        }
    }

    [Fact]
    public async Task MtAgentHost_AppliesExplicitUserProfileEnvironmentToSpawnedCodexProcess()
    {
        using var fakeCodex = FakeCodexPathScope.Create();
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        var profileDirectory = Path.Combine(fakeCodex.Root, "Users", "johan");
        Directory.CreateDirectory(Path.Combine(profileDirectory, "AppData", "Roaming", "npm"));
        Directory.CreateDirectory(Path.Combine(profileDirectory, "AppData", "Local", "Programs", "nodejs"));
        Directory.CreateDirectory(Path.Combine(profileDirectory, ".local", "bin"));

        try
        {
            _ = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-profile-env",
                SessionId = "session-profile-env",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-profile-env",
                    Provider = "codex",
                    WorkingDirectory = fakeCodex.Root,
                    UserProfileDirectory = profileDirectory
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-profile-env");
            Assert.Equal("accepted", attachResult.Status);

            var capture = await WaitForFakeCodexLaunchCaptureAsync(
                fakeCodex.CapturePath,
                static launch => !string.IsNullOrWhiteSpace(launch.UserProfile));

            Assert.Equal(profileDirectory, capture.UserProfile);
            Assert.Equal(profileDirectory, capture.Home);
            Assert.Equal(Path.Combine(profileDirectory, ".codex"), capture.CodexHome);
            Assert.Equal(Path.Combine(profileDirectory, "AppData", "Roaming"), capture.AppData);
            Assert.Equal(Path.Combine(profileDirectory, "AppData", "Local"), capture.LocalAppData);
            Assert.StartsWith(Path.Combine(profileDirectory, "AppData", "Roaming", "npm"), capture.Path, StringComparison.OrdinalIgnoreCase);
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
    public async Task MtAgentHost_NormalizesCamelCaseCodexItemsFromWebSocketRuntime()
    {
        await using var fakeServer = FakeCodexWebSocketServer.Start(
            loadedThreadId: "thread-remote-rich-1",
            assistantReply: "HELLO_FROM_CODEX",
            emitRichTranscriptItems: true);
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-rich",
                SessionId = "session-remote-rich",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-remote-rich",
                    Provider = "codex",
                    WorkingDirectory = AppContext.BaseDirectory,
                    AttachPoint = new SessionAgentAttachPoint
                    {
                        Provider = SessionAgentAttachPoint.CodexProvider,
                        TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                        Endpoint = fakeServer.Endpoint,
                        SharedRuntime = true,
                        Source = "test",
                        PreferredThreadId = "thread-remote-rich-1"
                    },
                    ResumeThreadId = "thread-remote-rich-1"
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-rich");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-rich",
                SessionId = "session-remote-rich",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Reply with exactly HELLO_FROM_CODEX",
                    Attachments = []
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-rich");
            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 14);

            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.completed" &&
                            envelope.Event.Item?.ItemType == "user_message" &&
                            envelope.Event.Item.Detail?.Contains("Reply with exactly HELLO_FROM_CODEX", StringComparison.Ordinal) == true);
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.completed" &&
                            envelope.Event.Item?.ItemType == "assistant_message" &&
                            envelope.Event.Item.Detail?.Contains("HELLO_FROM_CODEX", StringComparison.Ordinal) == true);
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.completed" &&
                            envelope.Event.Item?.ItemType == "command_execution" &&
                            envelope.Event.Item.Detail?.Contains("pwsh.exe -Command pwd", StringComparison.Ordinal) == true);
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.StreamKind == "assistant_text" &&
                            envelope.Event.ContentDelta.Delta.Contains("HELLO_FROM_CODEX", StringComparison.Ordinal));
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
    public async Task MtAgentHost_MapsCodexMcpToolProgressIntoCanonicalItemUpdates()
    {
        await using var fakeServer = FakeCodexWebSocketServer.Start(
            loadedThreadId: "thread-remote-mcp-1",
            assistantReply: "MCP progress handled.",
            emitRichTranscriptItems: true,
            emitTurnIds: true,
            emitMcpToolProgress: true);
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-mcp",
                SessionId = "session-remote-mcp",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-remote-mcp",
                    Provider = "codex",
                    WorkingDirectory = AppContext.BaseDirectory,
                    AttachPoint = new SessionAgentAttachPoint
                    {
                        Provider = SessionAgentAttachPoint.CodexProvider,
                        TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                        Endpoint = fakeServer.Endpoint,
                        SharedRuntime = true,
                        Source = "test",
                        PreferredThreadId = "thread-remote-mcp-1"
                    },
                    ResumeThreadId = "thread-remote-mcp-1"
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-mcp");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-mcp",
                SessionId = "session-remote-mcp",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Show MCP tool progress.",
                    Attachments = []
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-mcp");
            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 16);

            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.updated" &&
                            envelope.Event.ItemId == "item-mcp-1" &&
                            envelope.Event.TurnId == "turn-remote-1" &&
                            envelope.Event.Item?.ItemType == "mcp_tool_call" &&
                            envelope.Event.Item?.Title == "grep" &&
                            envelope.Event.Item?.Detail?.Contains("Searching src for Lens runtime events", StringComparison.Ordinal) == true);
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.completed" &&
                            envelope.Event.ItemId == "item-mcp-1" &&
                            envelope.Event.Item?.ItemType == "mcp_tool_call");
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
    public async Task MtAgentHost_EmitsFallbackLensItemForUnknownCodexNotifications()
    {
        await using var fakeServer = FakeCodexWebSocketServer.Start(
            loadedThreadId: "thread-remote-unknown-1",
            assistantReply: "Unknown event handled.",
            emitRichTranscriptItems: true,
            emitTurnIds: true,
            emitUnknownAgentNotification: true);
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-unknown",
                SessionId = "session-remote-unknown",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-remote-unknown",
                    Provider = "codex",
                    WorkingDirectory = AppContext.BaseDirectory,
                    AttachPoint = new SessionAgentAttachPoint
                    {
                        Provider = SessionAgentAttachPoint.CodexProvider,
                        TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                        Endpoint = fakeServer.Endpoint,
                        SharedRuntime = true,
                        Source = "test",
                        PreferredThreadId = "thread-remote-unknown-1"
                    },
                    ResumeThreadId = "thread-remote-unknown-1"
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-unknown");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-unknown",
                SessionId = "session-remote-unknown",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Show an unknown Codex event.",
                    Attachments = []
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-unknown");
            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 20);

            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.updated" &&
                            envelope.Event.TurnId == "turn-remote-1" &&
                            envelope.Event.Item?.ItemType == "unknown_agent_message" &&
                            envelope.Event.Item?.Title == "Unknown agent message" &&
                            envelope.Event.Item?.Detail?.Contains("codex/event/background_terminal_wait", StringComparison.Ordinal) == true &&
                            envelope.Event.Item?.Detail?.Contains("Waited for background terminal  npm run lint", StringComparison.Ordinal) == true);
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
    public async Task MtAgentHost_PreservesPayloadTurnIdForLateCodexDiffNotifications()
    {
        await using var fakeServer = FakeCodexWebSocketServer.Start(
            loadedThreadId: "thread-remote-late-diff-1",
            assistantReply: "Remote Codex reply with late diff.",
            emitTurnIds: true,
            emitLateDiffAfterCompletion: true);
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-late-diff",
                SessionId = "session-remote-late-diff",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-remote-late-diff",
                    Provider = "codex",
                    WorkingDirectory = AppContext.BaseDirectory,
                    AttachPoint = new SessionAgentAttachPoint
                    {
                        Provider = SessionAgentAttachPoint.CodexProvider,
                        TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                        Endpoint = fakeServer.Endpoint,
                        SharedRuntime = true,
                        Source = "test",
                        PreferredThreadId = "thread-remote-late-diff-1"
                    },
                    ResumeThreadId = "thread-remote-late-diff-1"
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-late-diff");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-late-diff",
                SessionId = "session-remote-late-diff",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Show a late diff update.",
                    Attachments = []
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-late-diff");
            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "diff.updated",
                maxEvents: 10);

            var diffEvent = Assert.Single(turnEvents, envelope => envelope.Event.Type == "diff.updated");
            Assert.Equal("turn-remote-1", diffEvent.Event.TurnId);
            Assert.Equal("--- a/remote.txt\n+++ b/remote.txt\n@@ -1 +1 @@\n-old\n+new", diffEvent.Event.DiffUpdated?.UnifiedDiff);
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

    private static async Task<FakeCodexLaunchCapture> WaitForFakeCodexLaunchCaptureAsync(
        string capturePath,
        Func<FakeCodexLaunchCapture, bool> predicate)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (File.Exists(capturePath))
            {
                try
                {
                    var json = await File.ReadAllTextAsync(capturePath);
                    if (!string.IsNullOrWhiteSpace(json))
                    {
                        var capture = JsonSerializer.Deserialize<FakeCodexLaunchCapture>(json);
                        if (capture is not null && predicate(capture))
                        {
                            return capture;
                        }
                    }
                }
                catch (JsonException)
                {
                }
                catch (IOException)
                {
                }
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"Timed out waiting for fake Codex launch capture at '{capturePath}'.");
    }

    private sealed class FakeCodexLaunchCapture
    {
        public string[] Arguments { get; set; } = [];

        public string? ProcessWorkingDirectory { get; set; }

        public string? UserProfile { get; set; }

        public string? Home { get; set; }

        public string? CodexHome { get; set; }

        public string? AppData { get; set; }

        public string? LocalAppData { get; set; }

        public string? Path { get; set; }

        public List<string> Methods { get; set; } = [];

        public string? InitializeClientName { get; set; }

        public string? InitializeClientTitle { get; set; }

        public string? InitializeClientVersion { get; set; }

        public bool? InitializeExperimentalApi { get; set; }

        public string? ThreadStartCwd { get; set; }

        public string? ThreadStartApprovalPolicy { get; set; }

        public string? ThreadStartSandbox { get; set; }

        public bool? ThreadStartExperimentalRawEvents { get; set; }
    }
}
