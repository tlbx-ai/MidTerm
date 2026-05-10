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
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        var marker = "MIDTERM_REAL_CLAUDE_SMOKE_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            var hello = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Equal(AppServerControlHostProtocol.CurrentVersion, hello.ProtocolVersion);
            Assert.Contains("claude", hello.Providers);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-claude",
                SessionId = "session-real-claude",
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = "session-real-claude",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            var attachResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach-real-claude");
            Assert.Equal("accepted", attachResult.Status);

            _ = await WaitForReadyWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude");

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-claude",
                SessionId = "session-real-claude",
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = $"Reply with exactly {marker} and nothing else.",
                    Attachments = []
                }
            });

            var turnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-real-claude");
            Assert.Equal("accepted", turnResult.Status);
            Assert.NotNull(turnResult.TurnStarted);

            var turnWindow = await WaitForTurnStateWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude",
                "completed");
            Assert.Contains(marker, AppServerControlHostTestClient.CollectAssistantText(turnWindow), StringComparison.Ordinal);
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
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        var marker = "MIDTERM_REAL_CLAUDE_RESUME_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            var hello = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-resume",
                SessionId = "session-real-claude-resume",
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-resume",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach-real-resume");
            var attachWindow = await WaitForReadyWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-resume");

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-resume-1",
                SessionId = "session-real-claude-resume",
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = $"Remember this exact token for the next turn: {marker}",
                    Attachments = []
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-real-resume-1");
            var firstTurnWindow = await WaitForTurnStateWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-resume",
                "completed");

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-resume-2",
                SessionId = "session-real-claude-resume",
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "What was the exact token from the previous turn? Reply with the token only.",
                    Attachments = []
                }
            });

            var secondTurnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-real-resume-2");
            Assert.Equal("accepted", secondTurnResult.Status);
            Assert.Equal(attachWindow.Thread.ThreadId, secondTurnResult.TurnStarted!.ThreadId);

            var secondTurnWindow = await WaitForTurnStateWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-resume",
                "completed");
            var assistantText = AppServerControlHostTestClient.CollectAssistantText(secondTurnWindow);
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
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();

        try
        {
            var hello = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-rich",
                SessionId = "session-real-claude-rich",
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-rich",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach-real-rich");
            _ = await WaitForReadyWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-rich");

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-rich",
                SessionId = "session-real-claude-rich",
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
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
                        new AppServerControlAttachmentReference
                        {
                            Kind = "file",
                            Path = inventoryPath
                        }
                    ]
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-real-rich");
            var turnWindow = await WaitForTurnStateWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-rich",
                "completed");

            Assert.Contains(turnWindow.History, item => item.ItemType is "command_execution" or "dynamic_tool_call");
            Assert.Contains(turnWindow.History, item => item.ItemType == "assistant_message");

            var assistantText = AppServerControlHostTestClient.CollectAssistantText(turnWindow);
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

    [Fact(Skip = "Claude AppServerControl interview/user-input is intentionally unsupported until MidTerm integrates a verified structured Claude contract.")]
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
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();

        try
        {
            var hello = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-qa",
                SessionId = "session-real-claude-qa",
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-qa",
                    Provider = "claude",
                    WorkingDirectory = workdir
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach-real-qa");
            _ = await WaitForReadyWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-qa");

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-qa",
                SessionId = "session-real-claude-qa",
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
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

                    Do not finish early. Ask for the answers before you continue.
                    """,
                    Attachments = []
                }
            });

            var turnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-real-qa");
            Assert.Equal("accepted", turnResult.Status);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => patch.Patch.RequestUpserts.Any(static request => request.Kind == "interview" && request.State == "open"),
                maxPatches: 120,
                timeout: TimeSpan.FromSeconds(60));

            var firstQuestionWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-qa",
                count: 160);
            var firstQuestionRequest = Assert.Single(firstQuestionWindow.Requests, request => request.Kind == "interview" && request.State == "open");
            Assert.Equal(2, firstQuestionRequest.Questions.Count);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-answer-real-qa-1",
                SessionId = "session-real-claude-qa",
                Type = "user-input.resolve",
                ResolveUserInput = new AppServerControlUserInputResolutionCommand
                {
                    RequestId = firstQuestionRequest.RequestId,
                    Answers =
                    [
                        new AppServerControlAnsweredQuestion { QuestionId = firstQuestionRequest.Questions[0].Id, Answers = ["C#"] },
                        new AppServerControlAnsweredQuestion { QuestionId = firstQuestionRequest.Questions[1].Id, Answers = ["Strict"] }
                    ]
                }
            });

            var firstAnswerResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-answer-real-qa-1");
            Assert.Equal("accepted", firstAnswerResult.Status);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch =>
                    patch.Patch.RequestUpserts.Any(request =>
                        request.Kind == "interview" &&
                        request.State == "open" &&
                        !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal)) ||
                    string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 160,
                timeout: TimeSpan.FromSeconds(60));

            var secondQuestionWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-qa",
                count: 220);

            var secondQuestionRequest = secondQuestionWindow.Requests.SingleOrDefault(request =>
                request.Kind == "interview" &&
                request.State == "open" &&
                !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal));

            if (secondQuestionRequest is null)
            {
                await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
                {
                    CommandId = "cmd-turn-real-qa-2",
                    SessionId = "session-real-claude-qa",
                    Type = "turn.start",
                    StartTurn = new AppServerControlTurnRequest
                    {
                        Text =
                            """
                            Ask exactly two multiple-choice questions before you continue:
                            - First: which final answer style should be used, with options `Concise` and `Detailed`.
                            - Second: whether workspace inspection is allowed, with options `Yes` and `No`.

                            Ask for those answers before you continue.
                            """,
                        Attachments = []
                    }
                });

                var secondTurnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-real-qa-2");
                Assert.Equal("accepted", secondTurnResult.Status);

                _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                    process.StandardOutput,
                    pendingPatches,
                    patch => patch.Patch.RequestUpserts.Any(request =>
                        request.Kind == "interview" &&
                        request.State == "open" &&
                        !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal)),
                    maxPatches: 120,
                    timeout: TimeSpan.FromSeconds(60));

                secondQuestionWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                    process.StandardOutput,
                    process.StandardInput,
                    pendingPatches,
                    "session-real-claude-qa",
                    count: 260);
                secondQuestionRequest = Assert.Single(
                    secondQuestionWindow.Requests,
                    request => request.Kind == "interview" &&
                               request.State == "open" &&
                               !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal));
            }

            Assert.Equal(2, secondQuestionRequest.Questions.Count);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-answer-real-qa-2",
                SessionId = "session-real-claude-qa",
                Type = "user-input.resolve",
                ResolveUserInput = new AppServerControlUserInputResolutionCommand
                {
                    RequestId = secondQuestionRequest.RequestId,
                    Answers =
                    [
                        new AppServerControlAnsweredQuestion { QuestionId = secondQuestionRequest.Questions[0].Id, Answers = ["Detailed"] },
                        new AppServerControlAnsweredQuestion { QuestionId = secondQuestionRequest.Questions[1].Id, Answers = ["Yes"] }
                    ]
                }
            });

            var secondAnswerResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-answer-real-qa-2");
            Assert.Equal("accepted", secondAnswerResult.Status);

            var resolvedWindow = await WaitForTurnStateWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-real-claude-qa",
                "completed");
            Assert.Contains(resolvedWindow.Requests, request => request.RequestId == firstQuestionRequest.RequestId && request.State == "resolved");
            Assert.Contains(resolvedWindow.Requests, request => request.RequestId == secondQuestionRequest.RequestId && request.State == "resolved");
            Assert.Contains(marker, AppServerControlHostTestClient.CollectAssistantText(resolvedWindow), StringComparison.Ordinal);
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
        process.StartInfo.Environment["MIDTERM_APP_SERVER_CONTROL_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"] = "true";
        process.Start();
        return process;
    }

    private static string ResolveAgentHostDll()
    {
        return MtAgentHostTestPathResolver.ResolveAgentHostDll(AppContext.BaseDirectory);
    }

    private static async Task<AppServerControlHistoryWindowResponse> WaitForReadyWindowAsync(
        StreamReader reader,
        StreamWriter writer,
        Queue<AppServerControlHostHistoryPatchEnvelope> pendingPatches,
        string sessionId)
    {
        return await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
            reader,
            writer,
            pendingPatches,
            sessionId,
            window => string.Equals(window.Session.State, "ready", StringComparison.Ordinal),
            TimeSpan.FromSeconds(60),
            count: 240);
    }

    private static async Task<AppServerControlHistoryWindowResponse> WaitForTurnStateWindowAsync(
        StreamReader reader,
        StreamWriter writer,
        Queue<AppServerControlHostHistoryPatchEnvelope> pendingPatches,
        string sessionId,
        string state)
    {
        return await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
            reader,
            writer,
            pendingPatches,
            sessionId,
            window => string.Equals(window.CurrentTurn.State, state, StringComparison.Ordinal),
            TimeSpan.FromSeconds(180),
            count: 320);
    }
}
