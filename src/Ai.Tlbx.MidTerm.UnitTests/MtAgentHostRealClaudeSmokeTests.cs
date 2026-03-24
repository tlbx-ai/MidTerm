using System.Diagnostics;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MtAgentHostRealClaudeSmokeTests
{
    [Fact]
    [Trait("Category", "RealClaude")]
    public async Task MtAgentHost_CanAttachAndCompleteRealClaudeTurn()
    {
        if (!IsRealClaudeSmokeEnabled())
        {
            return;
        }

        var hostDll = ResolveAgentHostDll();
        var workdir = Path.Combine(Path.GetTempPath(), "midterm-real-claude-smoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workdir);

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        var marker = "MIDTERM_REAL_CLAUDE_SMOKE_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Equal(LensHostProtocol.CurrentVersion, hello.ProtocolVersion);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-claude",
                SessionId = "session-real-claude",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-claude",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-real-claude");
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 8);
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "session.ready");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-claude",
                SessionId = "session-real-claude",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $"Reply with exactly {marker} and nothing else.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-claude");
            Assert.Equal("accepted", turnResult.Status);
            Assert.NotNull(turnResult.TurnStarted);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 120);
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.started");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.completed");
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" &&
                            envelope.Event.ContentDelta?.StreamKind == "assistant_text");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            try
            {
                Directory.Delete(workdir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    [Trait("Category", "RealClaude")]
    public async Task MtAgentHost_CanResumeRealClaudeConversationAcrossTurns()
    {
        if (!IsRealClaudeSmokeEnabled())
        {
            return;
        }

        var hostDll = ResolveAgentHostDll();
        var workdir = Path.Combine(Path.GetTempPath(), "midterm-real-claude-resume-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workdir);

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        var marker = "MIDTERM_REAL_CLAUDE_RESUME_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-resume",
                SessionId = "session-real-claude-resume",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-resume",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-real-resume");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 8);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-resume-1",
                SessionId = "session-real-claude-resume",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $"Remember this exact token for the next turn: {marker}",
                    Attachments = []
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-resume-1");
            var firstTurnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 160);
            var threadEvent = Assert.Single(firstTurnEvents, envelope => envelope.Event.Type == "thread.started");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-resume-2",
                SessionId = "session-real-claude-resume",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "What was the exact token from the previous turn? Reply with the token only.",
                    Attachments = []
                }
            });

            var secondTurnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-resume-2");
            Assert.Equal("accepted", secondTurnResult.Status);
            Assert.Equal(threadEvent.Event.ThreadState!.ProviderThreadId, secondTurnResult.TurnStarted!.ThreadId);

            var secondTurnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 160);
            var assistantText = CollectAssistantText(secondTurnEvents);
            Assert.Contains(marker, assistantText, StringComparison.Ordinal);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            try
            {
                Directory.Delete(workdir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    [Trait("Category", "RealClaude")]
    public async Task MtAgentHost_CanDriveRealClaudeWorkspaceTurnWithAttachments()
    {
        if (!IsRealClaudeSmokeEnabled())
        {
            return;
        }

        var hostDll = ResolveAgentHostDll();
        var workdir = Path.Combine(Path.GetTempPath(), "midterm-real-claude-rich-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workdir);
        var marker = "MIDTERM_REAL_CLAUDE_RICH_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        var inventoryPath = Path.Combine(workdir, "inventory.csv");
        await File.WriteAllTextAsync(
            inventoryPath,
            """
            name,count,owner
            alpha,3,Ada
            beta,5,Linus
            gamma,8,Grace
            """,
            Encoding.UTF8);

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-rich",
                SessionId = "session-real-claude-rich",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-rich",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-real-rich");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 8);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-rich",
                SessionId = "session-real-claude-rich",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $$"""
                    Inspect the attached CSV and the workspace.

                    Use tools where helpful. In the final response include:
                    1. a short two-step plan,
                    2. a markdown table for the inventory rows,
                    3. the exact marker {{marker}}.
                    """,
                    Attachments =
                    [
                        new LensAttachmentReference
                        {
                            Kind = "file",
                            Path = inventoryPath
                        }
                    ]
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-rich");
            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 400);

            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.started");
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.started" &&
                            envelope.Event.Item?.ItemType is "command_execution" or "dynamic_tool_call");
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "item.completed" &&
                            envelope.Event.Item?.ItemType is "assistant_message" or "command_execution" or "dynamic_tool_call");

            var assistantText = CollectAssistantText(turnEvents);
            Assert.Contains(marker, assistantText, StringComparison.Ordinal);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            try
            {
                Directory.Delete(workdir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    [Trait("Category", "RealClaude")]
    public async Task MtAgentHost_CanDriveRealClaudeThroughTwoUserInputRounds()
    {
        if (!IsRealClaudeSmokeEnabled())
        {
            return;
        }

        var hostDll = ResolveAgentHostDll();
        var workdir = Path.Combine(Path.GetTempPath(), "midterm-real-claude-qa-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workdir);
        var marker = "MIDTERM_REAL_CLAUDE_QA_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-qa",
                SessionId = "session-real-claude-qa",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-qa",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-real-qa");
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 8);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-qa",
                SessionId = "session-real-claude-qa",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $$"""
                    Ask exactly two rounds of questions before you finish.

                    Round 1:
                    - Ask two multiple-choice questions.
                    - First question: which runtime should be prioritized, with options `C#` and `TypeScript`.
                    - Second question: which validation level should be used, with options `Strict` and `Balanced`.

                    Round 2, after I answer round 1:
                    - Ask two more multiple-choice questions.
                    - First question: which final answer style should be used, with options `Concise` and `Detailed`.
                    - Second question: whether workspace inspection is allowed, with options `Yes` and `No`.

                    After I answer round 2, reply with:
                    - the exact marker {{marker}}
                    - one compact summary line listing all four chosen answers

                    Do not finish early. Use the MidTerm input bridge whenever you need answers.
                    """,
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-qa");
            Assert.Equal("accepted", turnResult.Status);

            var firstQuestionEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.requested",
                maxEvents: 120);
            var firstQuestionEvent = Assert.Single(firstQuestionEvents, envelope => envelope.Event.Type == "user-input.requested");
            Assert.Equal(2, firstQuestionEvent.Event.UserInputRequested!.Questions.Count);
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.state.changed" &&
                            string.Equals(envelope.Event.SessionState?.State, "waiting_for_input", StringComparison.Ordinal),
                maxEvents: 12);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-answer-real-qa-1",
                SessionId = "session-real-claude-qa",
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = firstQuestionEvent.Event.RequestId!,
                    Answers =
                    [
                        new LensPulseAnsweredQuestion { QuestionId = firstQuestionEvent.Event.UserInputRequested.Questions[0].Id, Answers = ["C#"] },
                        new LensPulseAnsweredQuestion { QuestionId = firstQuestionEvent.Event.UserInputRequested.Questions[1].Id, Answers = ["Strict"] }
                    ]
                }
            });

            var firstAnswerResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-answer-real-qa-1");
            Assert.Equal("accepted", firstAnswerResult.Status);

            var secondRoundEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope =>
                    envelope.Event.Type == "user-input.requested" ||
                    envelope.Event.Type == "turn.completed" ||
                    (envelope.Event.Type == "session.state.changed" &&
                     string.Equals(envelope.Event.SessionState?.State, "ready", StringComparison.Ordinal)),
                maxEvents: 160);

            LensHostEventEnvelope secondQuestionEvent;
            var inlineSecondQuestion = secondRoundEvents.SingleOrDefault(envelope => envelope.Event.Type == "user-input.requested");
            if (inlineSecondQuestion is not null)
            {
                secondQuestionEvent = inlineSecondQuestion;
            }
            else
            {
                await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
                {
                    CommandId = "cmd-turn-real-qa-2",
                    SessionId = "session-real-claude-qa",
                    Type = "turn.start",
                    StartTurn = new LensTurnRequest
                    {
                        Text =
                            """
                            Ask exactly two multiple-choice questions before you continue:
                            - First: which final answer style should be used, with options `Concise` and `Detailed`.
                            - Second: whether workspace inspection is allowed, with options `Yes` and `No`.

                            Use the MidTerm input bridge for these questions.
                            """,
                        Attachments = []
                    }
                });

                var secondTurnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-qa-2");
                Assert.Equal("accepted", secondTurnResult.Status);

                var followupQuestionEvents = await LensHostTestClient.ReadUntilAsync(
                    process.StandardOutput,
                    pendingEvents,
                    envelope => envelope.Event.Type == "user-input.requested",
                    maxEvents: 120);
                secondQuestionEvent = Assert.Single(followupQuestionEvents, envelope => envelope.Event.Type == "user-input.requested");
            }

            Assert.Equal(2, secondQuestionEvent.Event.UserInputRequested!.Questions.Count);
            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.state.changed" &&
                            string.Equals(envelope.Event.SessionState?.State, "waiting_for_input", StringComparison.Ordinal),
                maxEvents: 12);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-answer-real-qa-2",
                SessionId = "session-real-claude-qa",
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = secondQuestionEvent.Event.RequestId!,
                    Answers =
                    [
                        new LensPulseAnsweredQuestion { QuestionId = secondQuestionEvent.Event.UserInputRequested.Questions[0].Id, Answers = ["Detailed"] },
                        new LensPulseAnsweredQuestion { QuestionId = secondQuestionEvent.Event.UserInputRequested.Questions[1].Id, Answers = ["Yes"] }
                    ]
                }
            });

            var secondAnswerResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-answer-real-qa-2");
            Assert.Equal("accepted", secondAnswerResult.Status);

            var resolvedEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "user-input.resolved",
                maxEvents: 12);
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

            try
            {
                Directory.Delete(workdir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static bool IsRealClaudeSmokeEnabled()
    {
        var enabled = Environment.GetEnvironmentVariable("MIDTERM_RUN_REAL_CLAUDE_TESTS");
        if (!string.Equals(enabled, "1", StringComparison.Ordinal))
        {
            return false;
        }

        return ResolveClaudeOnPath() is not null;
    }

    private static string? ResolveClaudeOnPath()
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        foreach (var entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var cmd = Path.Combine(entry, "claude.cmd");
            if (File.Exists(cmd))
            {
                return cmd;
            }

            var exe = Path.Combine(entry, "claude.exe");
            if (File.Exists(exe))
            {
                return exe;
            }

            var bare = Path.Combine(entry, "claude");
            if (File.Exists(bare))
            {
                return bare;
            }
        }

        return null;
    }

    private static Process StartAgentHost(string hostDll)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "dotnet",
                Arguments = $"\"{hostDll}\" --stdio",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };
        process.StartInfo.Environment["MIDTERM_LENS_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"] = "true";
        process.Start();
        return process;
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

    private static string CollectAssistantText(IEnumerable<LensHostEventEnvelope> events)
    {
        return string.Join(
            Environment.NewLine,
            events.SelectMany(static envelope =>
            {
                var values = new List<string>();
                if (envelope.Event.Type == "content.delta" &&
                    string.Equals(envelope.Event.ContentDelta?.StreamKind, "assistant_text", StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(envelope.Event.ContentDelta?.Delta))
                {
                    values.Add(envelope.Event.ContentDelta!.Delta);
                }

                if (envelope.Event.Type == "item.completed" &&
                    string.Equals(envelope.Event.Item?.ItemType, "assistant_message", StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(envelope.Event.Item?.Detail))
                {
                    values.Add(envelope.Event.Item!.Detail!);
                }

                if (envelope.Event.Type == "session.state.changed" &&
                    !string.IsNullOrWhiteSpace(envelope.Event.SessionState?.Reason))
                {
                    values.Add(envelope.Event.SessionState!.Reason!);
                }

                return values;
            }));
    }
}
