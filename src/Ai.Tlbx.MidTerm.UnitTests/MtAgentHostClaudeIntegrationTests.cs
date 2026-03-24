using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class MtAgentHostClaudeIntegrationTests
{
    [Fact]
    public async Task MtAgentHost_CanDriveFakeClaudeAcrossMultipleTurns()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var hostDll = ResolveAgentHostDll();
        var attachmentPath = Path.Combine(fakeClaude.Root, "notes.txt");
        await File.WriteAllTextAsync(attachmentPath, "attached text file");

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = "session-claude-1",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-claude-1",
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach");
            Assert.Equal("accepted", attachResult.Status);
            var attachEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "session.started");
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "session.ready");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-1",
                SessionId = "session-claude-1",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Inspect the attached file.",
                    Attachments =
                    [
                        new LensAttachmentReference { Kind = "file", Path = attachmentPath }
                    ]
                }
            });

            var firstTurnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-1");
            Assert.Equal("accepted", firstTurnResult.Status);
            Assert.Equal("claude", firstTurnResult.TurnStarted!.Provider);

            var firstTurnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 20);
            var threadEvent = Assert.Single(firstTurnEvents, envelope => envelope.Event.Type == "thread.started");
            Assert.Contains(firstTurnEvents, envelope => envelope.Event.Type == "turn.started");
            Assert.Contains(
                firstTurnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.StreamKind == "assistant_text" &&
                            envelope.Event.ContentDelta.Delta.Contains("Fake Claude reply.", StringComparison.Ordinal));
            Assert.Contains(
                firstTurnEvents,
                envelope => envelope.Event.Type == "item.started" &&
                            envelope.Event.Item?.ItemType == "command_execution");
            Assert.Contains(
                firstTurnEvents,
                envelope => envelope.Event.Type == "item.completed" &&
                            envelope.Event.Item?.ItemType == "assistant_message" &&
                            envelope.Event.Item.Detail?.Contains("attachments=1", StringComparison.Ordinal) == true);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-2",
                SessionId = "session-claude-1",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Continue in the same conversation.",
                    Attachments = []
                }
            });

            var secondTurnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-2");
            Assert.Equal("accepted", secondTurnResult.Status);
            Assert.Equal(threadEvent.Event.ThreadState!.ProviderThreadId, secondTurnResult.TurnStarted!.ThreadId);

            var secondTurnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 20);
            Assert.Contains(
                secondTurnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.StreamKind == "assistant_text" &&
                            envelope.Event.ContentDelta.Delta.Contains("resumed=true", StringComparison.Ordinal));
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
    public async Task MtAgentHost_CanInterruptFakeClaudeTurn()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            _ = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = "session-claude-interrupt",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-claude-interrupt",
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
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
                CommandId = "cmd-turn",
                SessionId = "session-claude-interrupt",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Please interrupt this Claude turn.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn");
            Assert.Equal("accepted", turnResult.Status);

            var startedEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.started",
                maxEvents: 8);
            var startedEvent = Assert.Single(startedEvents, envelope => envelope.Event.Type == "turn.started");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-interrupt",
                SessionId = "session-claude-interrupt",
                Type = "turn.interrupt",
                InterruptTurn = new LensInterruptRequest
                {
                    TurnId = startedEvent.Event.TurnId
                }
            });

            var interruptResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-interrupt");
            Assert.Equal("accepted", interruptResult.Status);

            var interruptEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.aborted",
                maxEvents: 10);
            Assert.Contains(
                interruptEvents,
                envelope => envelope.Event.Type == "turn.aborted" &&
                            string.Equals(envelope.Event.TurnCompleted?.StopReason, "interrupt", StringComparison.Ordinal));
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
    public async Task MtAgentHost_CanDriveFakeClaudeThroughTwoUserInputRounds()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        var marker = "MIDTERM_FAKE_CLAUDE_QA_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            _ = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-qa",
                SessionId = "session-claude-qa",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-claude-qa",
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-qa");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 4);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-qa",
                SessionId = "session-claude-qa",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $$"""
                    MIDTERM_CLAUDE_QA_TWO_PHASES
                    FINAL_MARKER={{marker}}

                    Ask exactly two sets of user questions before finishing.
                    """,
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-qa");
            Assert.Equal("accepted", turnResult.Status);

            var firstQuestionEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.requested",
                maxEvents: 20);
            var firstQuestionEvent = Assert.Single(firstQuestionEvents, envelope => envelope.Event.Type == "user-input.requested");
            Assert.Equal(2, firstQuestionEvent.Event.UserInputRequested!.Questions.Count);
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.state.changed" &&
                            string.Equals(envelope.Event.SessionState?.State, "waiting_for_input", StringComparison.Ordinal),
                maxEvents: 6);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-answer-qa-1",
                SessionId = "session-claude-qa",
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = firstQuestionEvent.Event.RequestId!,
                    Answers =
                    [
                        new LensPulseAnsweredQuestion { QuestionId = "language", Answers = ["C#"] },
                        new LensPulseAnsweredQuestion { QuestionId = "strictness", Answers = ["Strict"] }
                    ]
                }
            });

            var firstAnswerResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-answer-qa-1");
            Assert.Equal("accepted", firstAnswerResult.Status);

            var secondQuestionEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.requested",
                maxEvents: 24);
            Assert.Contains(secondQuestionEvents, envelope => envelope.Event.Type == "user-input.resolved");
            var secondQuestionEvent = Assert.Single(secondQuestionEvents, envelope => envelope.Event.Type == "user-input.requested");
            Assert.Equal(2, secondQuestionEvent.Event.UserInputRequested!.Questions.Count);
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.state.changed" &&
                            string.Equals(envelope.Event.SessionState?.State, "waiting_for_input", StringComparison.Ordinal),
                maxEvents: 6);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-answer-qa-2",
                SessionId = "session-claude-qa",
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = secondQuestionEvent.Event.RequestId!,
                    Answers =
                    [
                        new LensPulseAnsweredQuestion { QuestionId = "output-style", Answers = ["Detailed"] },
                        new LensPulseAnsweredQuestion { QuestionId = "workspace-scan", Answers = ["Yes"] }
                    ]
                }
            });

            var secondAnswerResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-answer-qa-2");
            Assert.Equal("accepted", secondAnswerResult.Status);

            var resolvedEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.resolved",
                maxEvents: 8);
            Assert.Contains(resolvedEvents, envelope => envelope.Event.Type == "user-input.resolved");
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
