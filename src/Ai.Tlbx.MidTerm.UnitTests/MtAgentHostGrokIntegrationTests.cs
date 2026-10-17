using System.Diagnostics;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class MtAgentHostGrokIntegrationTests
{
    [Theory]
    [InlineData("grok", "agent", "stdio")]
    [InlineData("opencode", "acp")]
    [InlineData("gemini", "--acp")]
    [InlineData("copilot", "--acp")]
    [InlineData("custom-acp", "--stdio-acp")]
    public async Task MtAgentHost_CanDriveStandardAcpAgent(string provider, params string[] expectedArguments)
    {
        using var fakeGrok = FakeGrokPathScope.Create();
        var hostDll = ResolveAgentHostDll();
        var sessionId = $"session-{provider}-" + Guid.NewGuid().ToString("N");
        using var process = StartAgentHost(hostDll);
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        var imagePath = Path.Combine(fakeGrok.Root, "pasted-image.png");
        var imageBytes = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
        await File.WriteAllBytesAsync(imagePath, imageBytes, Xunit.TestContext.Current.CancellationToken);

        try
        {
            var hello = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("acp-v1", hello.Providers, StringComparer.Ordinal);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = provider,
                    RuntimeKind = "acp-v1",
                    ExecutablePath = fakeGrok.ExecutablePath,
                    AgentName = "Fake ACP agent",
                    ExecutableArguments = expectedArguments.ToList(),
                    WorkingDirectory = fakeGrok.Root
                }
            });

            var attachResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach");
            Assert.True(
                string.Equals("accepted", attachResult.Status, StringComparison.Ordinal),
                attachResult.Message ?? $"Unexpected attach status '{attachResult.Status}'.");
            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 8,
                timeout: TimeSpan.FromSeconds(10));

            var attachWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 32);
            Assert.Equal(provider, attachWindow.Provider);
            Assert.Equal("grok-build-0.1", attachWindow.QuickSettings.Model);
            Assert.Contains(attachWindow.QuickSettings.ModelOptions, option => option.Value == "grok-4.3");
            var capture = await WaitForFakeGrokLaunchCaptureAsync(
                fakeGrok.CapturePath,
                static launch => launch.Arguments.Length > 0);
            Assert.Equal(expectedArguments, capture.Arguments);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "Inspect the workspace.",
                    Attachments =
                    [
                        new AppServerControlAttachmentReference
                        {
                            Kind = "image",
                            Path = imagePath,
                            MimeType = "image/png",
                            DisplayName = "pasted-image.png"
                        }
                    ]
                }
            });

            var turnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn");
            Assert.Equal("accepted", turnResult.Status);
            Assert.Equal(provider, turnResult.TurnStarted!.Provider);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 40,
                timeout: TimeSpan.FromSeconds(10));

            var turnWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 96);
            Assert.Contains("Fake Grok reply.", turnWindow.Streams.AssistantText, StringComparison.Ordinal);
            Assert.Contains($"[image image/png {imageBytes.Length} bytes]", turnWindow.Streams.AssistantText, StringComparison.Ordinal);
            Assert.Contains("Fake Grok is thinking.", turnWindow.Streams.ReasoningText, StringComparison.Ordinal);
            Assert.Contains(turnWindow.Items, item => item.ItemType == "dynamic_tool_call" && item.Status == "completed");
            Assert.Contains(
                turnWindow.Notices,
                notice => notice.Type == "agent.state" &&
                          notice.Message.Contains("commands available: compact, always-approve.", StringComparison.Ordinal));
            Assert.Contains(
                turnWindow.Notices,
                notice => notice.Type == "agent.state" &&
                          notice.Message.Contains("Fake Grok notification: Session notification handled.", StringComparison.Ordinal));
            Assert.Contains(
                turnWindow.Notices,
                notice => notice.Type == "thread.token-usage.updated" &&
                          notice.Detail?.Contains("1,234 / 128,000 context tokens, 0.0123 USD cumulative", StringComparison.Ordinal) == true);
            Assert.Contains(turnWindow.Notices, notice => notice.Detail == "_x.ai/session/setup");
            Assert.DoesNotContain(turnWindow.History, item => item.Body.Contains("ACP notification ignored", StringComparison.Ordinal));

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-2",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "Second turn in the same ACP session.",
                    Attachments = []
                }
            });
            var secondTurnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-2");
            Assert.Equal("accepted", secondTurnResult.Status);
            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.TurnId, secondTurnResult.TurnStarted!.TurnId, StringComparison.Ordinal) &&
                         string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 40,
                timeout: TimeSpan.FromSeconds(10));
            var secondWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 128);
            Assert.Equal(turnWindow.Thread.ThreadId, secondWindow.Thread.ThreadId);
            Assert.Contains("Second turn in the same ACP session.", secondWindow.Streams.AssistantText, StringComparison.Ordinal);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-permission",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "Inspect permission handling.",
                    PermissionMode = AppServerControlQuickSettings.PermissionModeManual
                }
            });
            var permissionTurn = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-permission");
            Assert.Equal("accepted", permissionTurn.Status);
            var approvalWindow = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                window => window.Requests.Any(request => request.State == "open"),
                TimeSpan.FromSeconds(10),
                count: 160);
            var approval = Assert.Single(approvalWindow.Requests, request => request.State == "open");
            Assert.Equal("command_execution_approval", approval.Kind);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-resolve-permission",
                SessionId = sessionId,
                Type = "request.resolve",
                ResolveRequest = new AppServerControlRequestResolutionCommand
                {
                    RequestId = approval.RequestId,
                    Decision = "accept"
                }
            });
            var permissionResolution = await AppServerControlHostTestClient.ReadResultAsync(
                process.StandardOutput,
                pendingPatches,
                "cmd-resolve-permission");
            Assert.Equal("accepted", permissionResolution.Status);
            var resolvedWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 160);
            Assert.Contains(
                resolvedWindow.Requests,
                request => request.RequestId == approval.RequestId && request.Decision == "accept" && request.State == "resolved");

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-interrupt",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest { Text = "Keep running until interrupt." }
            });
            var interruptTurn = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-interrupt");
            Assert.Equal("accepted", interruptTurn.Status);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-stale-interrupt",
                SessionId = sessionId,
                Type = "turn.interrupt",
                InterruptTurn = new AppServerControlInterruptRequest { TurnId = "a-previous-turn" }
            });
            var staleInterrupt = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-stale-interrupt");
            Assert.Equal("rejected", staleInterrupt.Status);
            Assert.Contains("no longer matches", staleInterrupt.Message, StringComparison.Ordinal);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-interrupt",
                SessionId = sessionId,
                Type = "turn.interrupt",
                InterruptTurn = new AppServerControlInterruptRequest { TurnId = interruptTurn.TurnStarted!.TurnId }
            });
            var interrupted = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-interrupt");
            Assert.Equal("accepted", interrupted.Status);
            var interruptedWindow = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                window => string.Equals(window.CurrentTurn.TurnId, interruptTurn.TurnStarted.TurnId, StringComparison.Ordinal) &&
                          string.Equals(window.CurrentTurn.State, "interrupted", StringComparison.Ordinal),
                TimeSpan.FromSeconds(10),
                count: 192);
            Assert.Equal("ready", interruptedWindow.Session.State);
            Assert.Contains(interruptedWindow.History, item =>
                item.TurnId == interruptTurn.TurnStarted.TurnId &&
                item.Body.Contains("Final update before cancellation settled.", StringComparison.Ordinal));

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-reattach",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = provider,
                    RuntimeKind = "acp-v1",
                    ExecutablePath = fakeGrok.ExecutablePath,
                    ExecutableArguments = expectedArguments.ToList(),
                    WorkingDirectory = fakeGrok.Root
                }
            });
            var reattached = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-reattach");
            Assert.Equal("accepted", reattached.Status);
            var afterReattach = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput, process.StandardInput, pendingPatches, sessionId, count: 192);
            Assert.Equal(interruptedWindow.Thread.ThreadId, afterReattach.Thread.ThreadId);
            Assert.Equal(interruptedWindow.HistoryCount, afterReattach.HistoryCount);
            Assert.Equal(interruptedWindow.CurrentTurn.State, afterReattach.CurrentTurn.State);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-running-before-steer",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest { Text = "Wait for interrupt and a replacement direction." }
            });
            var beforeSteer = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-running-before-steer");
            var previousTurnId = beforeSteer.TurnStarted!.TurnId;
            foreach (var (commandId, expectedId, text) in new[]
            {
                ("cmd-stale-steer", "stale-turn", "New direction"),
                ("cmd-empty-steer", previousTurnId!, " ")
            })
            {
                await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
                {
                    CommandId = commandId,
                    SessionId = sessionId,
                    Type = "turn.steer",
                    SteerTurn = new AppServerControlSteerRequest { ExpectedTurnId = expectedId, Text = text }
                });
                var invalidSteer = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, commandId);
                Assert.Equal("rejected", invalidSteer.Status);
            }

            const string replacementText = "Use the revised direction now.";
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-steer",
                SessionId = sessionId,
                Type = "turn.steer",
                SteerTurn = new AppServerControlSteerRequest { ExpectedTurnId = previousTurnId, Text = replacementText }
            });
            var steered = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-steer");
            Assert.Equal("accepted", steered.Status);
            Assert.NotNull(steered.Accepted?.TurnId);
            Assert.NotEqual(previousTurnId, steered.Accepted.TurnId, StringComparer.Ordinal);
            var steeredWindow = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput, process.StandardInput, pendingPatches, sessionId,
                window => window.CurrentTurn.TurnId == steered.Accepted.TurnId && window.CurrentTurn.State == "completed",
                TimeSpan.FromSeconds(10), count: 192);
            Assert.Equal(beforeSteer.TurnStarted.ThreadId, steeredWindow.Thread.ThreadId);
            Assert.Contains(steeredWindow.History, item => item.TurnId == previousTurnId &&
                item.Body.Contains("Final update before cancellation settled.", StringComparison.Ordinal));
            Assert.DoesNotContain(steeredWindow.History, item => item.TurnId == steered.Accepted.TurnId &&
                item.Body.Contains("Final update before cancellation settled.", StringComparison.Ordinal));
            Assert.Single(steeredWindow.History.Where(item => item.Kind == "user" &&
                item.TurnId == steered.Accepted.TurnId && item.Body == replacementText));
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync(Xunit.TestContext.Current.CancellationToken);
            await process.WaitForExitAsync(Xunit.TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task MtAgentHost_RejectsUnsupportedAcpProtocolVersion()
    {
        var previousVersion = Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_PROTOCOL_VERSION");
        Environment.SetEnvironmentVariable("MIDTERM_FAKE_GROK_PROTOCOL_VERSION", "2");
        using var fakeGrok = FakeGrokPathScope.Create();
        using var process = StartAgentHost(ResolveAgentHostDll());
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        try
        {
            _ = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach-invalid-protocol",
                SessionId = "session-invalid-acp-protocol",
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = "session-invalid-acp-protocol",
                    Provider = "custom-acp",
                    RuntimeKind = "acp-v1",
                    ExecutablePath = fakeGrok.ExecutablePath,
                    AgentName = "Fake ACP agent",
                    WorkingDirectory = fakeGrok.Root
                }
            });

            var result = await AppServerControlHostTestClient.ReadResultAsync(
                process.StandardOutput,
                pendingPatches,
                "cmd-attach-invalid-protocol");

            Assert.Equal("rejected", result.Status);
            Assert.Contains("requires ACP v1", result.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("MIDTERM_FAKE_GROK_PROTOCOL_VERSION", previousVersion);
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync(Xunit.TestContext.Current.CancellationToken);
            await process.WaitForExitAsync(Xunit.TestContext.Current.CancellationToken);
        }
    }

    [Theory]
    [InlineData("question-test")]
    [InlineData("question-test wrapped")]
    [InlineData("question-test legacy")]
    [InlineData("question-test legacy wrapped")]
    public async Task MtAgentHost_AnswersAndCancelsGrokQuestions(string prompt)
    {
        using var fake = FakeGrokPathScope.Create();
        using var process = StartAgentHost(ResolveAgentHostDll());
        var patches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        var sessionId = "session-grok-questions-" + Guid.NewGuid().ToString("N");
        try
        {
            _ = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "attach", SessionId = sessionId, Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId, Provider = "grok", RuntimeKind = "acp-v1",
                    ExecutablePath = fake.ExecutablePath, ExecutableArguments = ["agent", "stdio"], WorkingDirectory = fake.Root
                }
            });
            var attached = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "attach");
            Assert.Equal("accepted", attached.Status);

            async Task<AppServerControlRequestSummary> AskAsync(string commandId)
            {
                await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
                {
                    CommandId = commandId, SessionId = sessionId, Type = "turn.start",
                    StartTurn = new AppServerControlTurnRequest { Text = prompt }
                });
                var started = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, commandId);
                Assert.Equal("accepted", started.Status);
                var waiting = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                    process.StandardOutput, process.StandardInput, patches, sessionId,
                    window => window.Requests.Any(request => request.Kind == "interview" && request.State == "open"),
                    TimeSpan.FromSeconds(10), count: 96);
                return Assert.Single(waiting.Requests.Where(request => request.Kind == "interview" && request.State == "open"));
            }

            var question = await AskAsync("ask-1");
            Assert.Equal(3, question.Questions.Count);
            Assert.Equal("color", question.Questions[0].Id);
            Assert.Equal("Which checks?", question.Questions[1].Id);
            Assert.True(question.Questions[1].MultiSelect);
            Assert.Empty(question.Questions[2].Options);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "invalid-answer", SessionId = sessionId, Type = "user-input.resolve",
                ResolveUserInput = new AppServerControlUserInputResolutionCommand
                {
                    RequestId = question.RequestId,
                    Answers = [new AppServerControlAnsweredQuestion { QuestionId = "wrong-question", Answers = ["Blue"] }]
                }
            });
            var invalid = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "invalid-answer");
            Assert.Equal("rejected", invalid.Status);

            var resolve = new AppServerControlHostCommandEnvelope
            {
                CommandId = "answer", SessionId = sessionId, Type = "user-input.resolve",
                ResolveUserInput = new AppServerControlUserInputResolutionCommand
                {
                    RequestId = question.RequestId,
                    Answers =
                    [
                        new AppServerControlAnsweredQuestion { QuestionId = "color", Answers = ["Blue", "Prefer blue"] },
                        new AppServerControlAnsweredQuestion { QuestionId = "Which checks?", Answers = ["Tests", "Docs"] },
                        new AppServerControlAnsweredQuestion { QuestionId = "notes", Answers = ["Typed note"] }
                    ]
                }
            };
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, resolve);
            var answered = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "answer");
            Assert.Equal("accepted", answered.Status);
            var completed = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput, process.StandardInput, patches, sessionId,
                window => window.CurrentTurn.State == "completed", TimeSpan.FromSeconds(10), count: 96);
            using var nativeResponse = JsonDocument.Parse(completed.Streams.AssistantText);
            var nativeResult = nativeResponse.RootElement.GetProperty("result");
            Assert.Equal("accepted", nativeResult.GetProperty("outcome").GetString());
            var colorAnswers = nativeResult.GetProperty("answers").GetProperty("Which color?");
            Assert.Equal(1, colorAnswers.GetArrayLength());
            Assert.Equal("Blue", colorAnswers[0].GetString());
            Assert.Equal(2, nativeResult.GetProperty("answers").GetProperty("Which checks?").GetArrayLength());
            var noteAnswers = nativeResult.GetProperty("answers").GetProperty("Anything else?");
            Assert.Equal(1, noteAnswers.GetArrayLength());
            Assert.Equal("Other", noteAnswers[0].GetString());
            var annotations = nativeResult.GetProperty("annotations");
            Assert.Equal("#0000ff", annotations.GetProperty("Which color?").GetProperty("preview").GetString());
            Assert.Equal("Prefer blue", annotations.GetProperty("Which color?").GetProperty("notes").GetString());
            Assert.Equal("Typed note", annotations.GetProperty("Anything else?").GetProperty("notes").GetString());
            Assert.False(annotations.TryGetProperty("Which checks?", out _));
            var resolved = Assert.Single(completed.Requests.Where(request => request.RequestId == question.RequestId));
            Assert.Equal("resolved", resolved.State);
            Assert.Equal(3, resolved.Answers.Count);
            var interview = Assert.Single(completed.History.Where(item => item.RequestId == question.RequestId));
            Assert.Equal("interview", interview.ItemType);
            Assert.Equal(3, interview.Answers.Count);

            resolve.CommandId = "duplicate-answer";
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, resolve);
            var duplicate = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "duplicate-answer");
            Assert.Equal("rejected", duplicate.Status);

            var toCancel = await AskAsync("ask-2");
            Assert.NotEqual(question.RequestId, toCancel.RequestId, StringComparer.Ordinal);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cancel-question", SessionId = sessionId, Type = "turn.interrupt",
                InterruptTurn = new AppServerControlInterruptRequest { TurnId = toCancel.TurnId }
            });
            var cancelled = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "cancel-question");
            Assert.Equal("accepted", cancelled.Status);
            var stopped = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput, process.StandardInput, patches, sessionId,
                window => window.CurrentTurn.State == "interrupted", TimeSpan.FromSeconds(10), count: 96);
            var cancelledQuestion = Assert.Single(stopped.Requests.Where(request => request.RequestId == toCancel.RequestId));
            Assert.Equal("resolved", cancelledQuestion.State);
            Assert.Equal("cancel", cancelledQuestion.Decision);
            Assert.Equal("cancelled", Assert.Single(stopped.History.Where(item => item.RequestId == toCancel.RequestId)).Status);
            using var cancelledResponse = JsonDocument.Parse(stopped.Streams.AssistantText);
            Assert.Equal("cancelled", cancelledResponse.RootElement.GetProperty("result").GetProperty("outcome").GetString());
            Assert.DoesNotContain(stopped.Requests, request => request.State == "open");

            resolve.CommandId = "late-answer";
            resolve.ResolveUserInput!.RequestId = toCancel.RequestId;
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, resolve);
            var late = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "late-answer");
            Assert.Equal("rejected", late.Status);
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            _ = await process.StandardError.ReadToEndAsync(Xunit.TestContext.Current.CancellationToken);
            await process.WaitForExitAsync(Xunit.TestContext.Current.CancellationToken);
        }
    }

    private static string ResolveAgentHostDll()
    {
        var overridePath = Environment.GetEnvironmentVariable("MIDTERM_TEST_AGENTHOST_PATH");
        return !string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath)
            ? overridePath
            : MtAgentHostTestPathResolver.ResolveAgentHostDll(AppContext.BaseDirectory);
    }

    private static async Task<FakeGrokLaunchCapture> WaitForFakeGrokLaunchCaptureAsync(
        string capturePath,
        Func<FakeGrokLaunchCapture, bool> predicate)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (File.Exists(capturePath))
            {
                try
                {
                    var json = await File.ReadAllTextAsync(capturePath, Xunit.TestContext.Current.CancellationToken);
                    if (!string.IsNullOrWhiteSpace(json))
                    {
                        var capture = JsonSerializer.Deserialize<FakeGrokLaunchCapture>(json);
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

            await Task.Delay(50, Xunit.TestContext.Current.CancellationToken);
        }

        throw new TimeoutException($"Timed out waiting for fake Grok launch capture at '{capturePath}'.");
    }

    [Theory]
    [InlineData("load", true)]
    [InlineData("resume", true)]
    [InlineData("none", false)]
    [InlineData("reject", false)]
    public async Task MtAgentHost_ResumesOnlyTheRequestedNativeAcpSession(string capability, bool supported)
    {
        using var fake = FakeGrokPathScope.Create();
        using var process = StartAgentHost(ResolveAgentHostDll(), capability);
        var patches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        const string sessionId = "saved-acp-test";
        const string nativeThread = "saved-native-thread-739";
        try
        {
            _ = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "resume", SessionId = sessionId, Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId, Provider = "custom-acp", RuntimeKind = "acp-v1",
                    ExecutablePath = fake.ExecutablePath, WorkingDirectory = fake.Root,
                    ResumeThreadId = nativeThread
                }
            });
            var result = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "resume");
            Assert.Equal(supported ? "accepted" : "rejected", result.Status);
            if (!supported)
            {
                Assert.Contains(capability == "reject" ? "Saved session was not found" : "does not advertise", result.Message, StringComparison.Ordinal);
                return;
            }

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(process.StandardOutput, patches,
                patch => patch.Patch.Session.State == "ready", maxPatches: 30, timeout: TimeSpan.FromSeconds(10));
            var history = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput, process.StandardInput, patches, sessionId, count: 96);
            Assert.Equal(nativeThread, history.Thread.ThreadId);
            if (capability == "load")
            {
                var userMessages = history.History.Where(item => item.ItemType == "user_message").ToArray();
                Assert.Equal(2, userMessages.Length);
                Assert.Equal("Remember REPLAY_739.", userMessages[0].Body);
                Assert.Equal("What is the marker?", userMessages[1].Body);
                Assert.Contains(history.History, item => item.Kind == "assistant" && item.Body.Contains("Remembered REPLAY_739.", StringComparison.Ordinal));
                Assert.Contains("The marker is REPLAY_739.", history.Streams.AssistantText, StringComparison.Ordinal);
                Assert.Equal("completed", history.CurrentTurn.State);
            }
            else
            {
                Assert.DoesNotContain(history.History, item => item.ItemType == "user_message");
            }

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "continue", SessionId = sessionId, Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest { Text = "Continue the loaded conversation." }
            });
            var continued = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, patches, "continue");
            Assert.Equal("accepted", continued.Status);
            Assert.Equal(nativeThread, continued.TurnStarted!.ThreadId);
            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(process.StandardOutput, patches,
                patch => patch.Patch.CurrentTurn.State == "completed" && patch.Patch.CurrentTurn.TurnId == continued.TurnStarted.TurnId,
                maxPatches: 40, timeout: TimeSpan.FromSeconds(10));
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            _ = await process.StandardError.ReadToEndAsync(Xunit.TestContext.Current.CancellationToken);
            await process.WaitForExitAsync(Xunit.TestContext.Current.CancellationToken);
        }
    }

    private static Process StartAgentHost(string hostDll, string? resumeCapability = null)
    {
        var isNativeExecutable = string.Equals(Path.GetExtension(hostDll), ".exe", StringComparison.OrdinalIgnoreCase);
        var dotnetHost = ResolveDotNetHostPath();
        var startInfo = new ProcessStartInfo
        {
            FileName = isNativeExecutable ? hostDll : dotnetHost,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        if (!isNativeExecutable)
        {
            startInfo.ArgumentList.Add(hostDll);
        }
        if (resumeCapability is not null)
        {
            startInfo.Environment["MIDTERM_FAKE_GROK_RESUME_CAPABILITY"] = resumeCapability;
        }
        startInfo.ArgumentList.Add("--stdio");
        var process = Process.Start(startInfo)
                      ?? throw new InvalidOperationException("Failed to start mtagenthost.");
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

    private sealed class FakeGrokLaunchCapture
    {
        public string[] Arguments { get; set; } = [];
    }
}
