using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class MtAgentHostClaudeIntegrationTests
{
    private static readonly TimeSpan ClaudeTurnCompletionTimeout = TimeSpan.FromSeconds(60);

    [Fact]
    public async Task MtAgentHost_CanDriveFakeClaudeAcrossMultipleTurns()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var hostDll = ResolveAgentHostDll();
        var attachmentPath = Path.Combine(fakeClaude.Root, "notes.txt");
        var sessionId = "session-claude-" + Guid.NewGuid().ToString("N");
        await File.WriteAllTextAsync(attachmentPath, "attached text file");

        using var process = StartAgentHost(hostDll);
        var pendingPatches = new Queue<LensHostHistoryPatchEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach");
            Assert.Equal("accepted", attachResult.Status);
            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            var attachWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 16);
            Assert.Equal("ready", attachWindow.Session.State);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-1",
                SessionId = sessionId,
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

            var firstTurnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-1");
            Assert.Equal("accepted", firstTurnResult.Status);
            Assert.Equal("claude", firstTurnResult.TurnStarted!.Provider);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 40,
                timeout: ClaudeTurnCompletionTimeout);

            var firstTurnWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 96);
            var providerThreadId = firstTurnWindow.Thread.ThreadId;
            Assert.False(string.IsNullOrWhiteSpace(providerThreadId));
            Assert.Contains("Fake Claude reply.", firstTurnWindow.Streams.AssistantText, StringComparison.Ordinal);
            Assert.Contains(firstTurnWindow.History, item => !string.IsNullOrWhiteSpace(item.CommandText));
            Assert.Contains(
                firstTurnWindow.History,
                item => string.IsNullOrWhiteSpace(item.CommandText) &&
                        item.Body.Contains("attachments=1", StringComparison.Ordinal));

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-2",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Continue in the same conversation.",
                    Attachments = []
                }
            });

            var secondTurnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-2");
            Assert.Equal("accepted", secondTurnResult.Status);
            Assert.Equal(providerThreadId, secondTurnResult.TurnStarted!.ThreadId);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 40,
                timeout: ClaudeTurnCompletionTimeout);

            var secondTurnWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 128);
            Assert.Contains("Fake Claude reply.", LensHostTestClient.CollectAssistantText(secondTurnWindow), StringComparison.Ordinal);
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
        var sessionId = "session-claude-interrupt-" + Guid.NewGuid().ToString("N");
        using var process = StartAgentHost(hostDll);
        var pendingPatches = new Queue<LensHostHistoryPatchEnvelope>();

        try
        {
            _ = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach");
            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Please interrupt this Claude turn.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn");
            Assert.Equal("accepted", turnResult.Status);

            var startedWindow = await LensHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                window => string.Equals(window.CurrentTurn.State, "running", StringComparison.Ordinal) &&
                          !string.IsNullOrWhiteSpace(window.CurrentTurn.TurnId),
                TimeSpan.FromSeconds(10),
                count: 32);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-interrupt",
                SessionId = sessionId,
                Type = "turn.interrupt",
                InterruptTurn = new LensInterruptRequest
                {
                    TurnId = startedWindow.CurrentTurn.TurnId
                }
            });

            var interruptResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-interrupt");
            Assert.Equal("accepted", interruptResult.Status);

            var interruptedWindow = await LensHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                window => string.Equals(window.CurrentTurn.State, "interrupted", StringComparison.Ordinal),
                TimeSpan.FromSeconds(10),
                count: 48);
            Assert.Equal("interrupted", interruptedWindow.CurrentTurn.State);
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

    [Fact(Skip = "Claude Lens interview/user-input is intentionally unsupported until MidTerm integrates a verified structured Claude contract.")]
    public async Task MtAgentHost_CanDriveFakeClaudeThroughTwoUserInputRounds()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var hostDll = ResolveAgentHostDll();
        var sessionId = "session-claude-qa-" + Guid.NewGuid().ToString("N");
        using var process = StartAgentHost(hostDll);
        var pendingPatches = new Queue<LensHostHistoryPatchEnvelope>();
        var marker = "MIDTERM_FAKE_CLAUDE_QA_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            _ = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-qa",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            _ = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach-qa");
            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-qa",
                SessionId = sessionId,
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

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-qa");
            Assert.Equal("accepted", turnResult.Status);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => patch.Patch.RequestUpserts.Any(static request => request.Kind == "interview" && request.State == "open"),
                maxPatches: 20,
                timeout: TimeSpan.FromSeconds(10));

            var firstQuestionWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 96);
            var firstQuestionRequest = Assert.Single(firstQuestionWindow.Requests, request => request.Kind == "interview" && request.State == "open");
            Assert.Equal(2, firstQuestionRequest.Questions.Count);
            Assert.Equal("waiting_for_input", firstQuestionWindow.Session.State);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-answer-qa-1",
                SessionId = sessionId,
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = firstQuestionRequest.RequestId,
                    Answers =
                    [
                        new LensAnsweredQuestion { QuestionId = "language", Answers = ["C#"] },
                        new LensAnsweredQuestion { QuestionId = "strictness", Answers = ["Strict"] }
                    ]
                }
            });

            var firstAnswerResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-answer-qa-1");
            Assert.Equal("accepted", firstAnswerResult.Status);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => patch.Patch.RequestUpserts.Any(request =>
                    request.Kind == "interview" &&
                    request.State == "open" &&
                    !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal)),
                maxPatches: 24,
                timeout: TimeSpan.FromSeconds(10));

            var secondQuestionWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 128);
            Assert.Contains(secondQuestionWindow.Requests, request => request.RequestId == firstQuestionRequest.RequestId && request.State == "resolved");
            var secondQuestionRequest = Assert.Single(
                secondQuestionWindow.Requests,
                request => request.Kind == "interview" &&
                           request.State == "open" &&
                           !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal));
            Assert.Equal(2, secondQuestionRequest.Questions.Count);
            Assert.Equal("waiting_for_input", secondQuestionWindow.Session.State);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-answer-qa-2",
                SessionId = sessionId,
                Type = "user-input.resolve",
                ResolveUserInput = new LensUserInputResolutionCommand
                {
                    RequestId = secondQuestionRequest.RequestId,
                    Answers =
                    [
                        new LensAnsweredQuestion { QuestionId = "output-style", Answers = ["Detailed"] },
                        new LensAnsweredQuestion { QuestionId = "workspace-scan", Answers = ["Yes"] }
                    ]
                }
            });

            var secondAnswerResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-answer-qa-2");
            Assert.Equal("accepted", secondAnswerResult.Status);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 12,
                timeout: TimeSpan.FromSeconds(10));

            var resolvedWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 160);
            Assert.Equal("completed", resolvedWindow.CurrentTurn.State);
            Assert.Contains(resolvedWindow.Requests, request => request.RequestId == firstQuestionRequest.RequestId && request.State == "resolved");
            Assert.Contains(resolvedWindow.Requests, request => request.RequestId == secondQuestionRequest.RequestId && request.State == "resolved");
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

