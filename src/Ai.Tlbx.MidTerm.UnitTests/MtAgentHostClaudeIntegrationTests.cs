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
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();

        try
        {
            var hello = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            var attachResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach");
            Assert.Equal("accepted", attachResult.Status);
            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            var attachWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 16);
            Assert.Equal("ready", attachWindow.Session.State);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-1",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "Inspect the attached file.",
                    Attachments =
                    [
                        new AppServerControlAttachmentReference { Kind = "file", Path = attachmentPath }
                    ]
                }
            });

            var firstTurnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-1");
            Assert.Equal("accepted", firstTurnResult.Status);
            Assert.Equal("claude", firstTurnResult.TurnStarted!.Provider);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 40,
                timeout: ClaudeTurnCompletionTimeout);

            var firstTurnWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
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

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-2",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "Continue in the same conversation.",
                    Attachments = []
                }
            });

            var secondTurnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-2");
            Assert.Equal("accepted", secondTurnResult.Status);
            Assert.Equal(providerThreadId, secondTurnResult.TurnStarted!.ThreadId);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 40,
                timeout: ClaudeTurnCompletionTimeout);

            var secondTurnWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 128);
            Assert.Contains("Fake Claude reply.", AppServerControlHostTestClient.CollectAssistantText(secondTurnWindow), StringComparison.Ordinal);
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
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();

        try
        {
            _ = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach");
            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = "Please interrupt this Claude turn.",
                    Attachments = []
                }
            });

            var turnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn");
            Assert.Equal("accepted", turnResult.Status);

            var startedWindow = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                window => string.Equals(window.CurrentTurn.State, "running", StringComparison.Ordinal) &&
                          !string.IsNullOrWhiteSpace(window.CurrentTurn.TurnId),
                TimeSpan.FromSeconds(10),
                count: 32);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-interrupt",
                SessionId = sessionId,
                Type = "turn.interrupt",
                InterruptTurn = new AppServerControlInterruptRequest
                {
                    TurnId = startedWindow.CurrentTurn.TurnId
                }
            });

            var interruptResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-interrupt");
            Assert.Equal("accepted", interruptResult.Status);

            var interruptedWindow = await AppServerControlHostTestClient.WaitForHistoryWindowAsync(
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

    [Fact(Skip = "Claude AppServerControl interview/user-input is intentionally unsupported until MidTerm integrates a verified structured Claude contract.")]
    public async Task MtAgentHost_CanDriveFakeClaudeThroughTwoUserInputRounds()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var hostDll = ResolveAgentHostDll();
        var sessionId = "session-claude-qa-" + Guid.NewGuid().ToString("N");
        using var process = StartAgentHost(hostDll);
        var pendingPatches = new Queue<AppServerControlHostHistoryPatchEnvelope>();
        var marker = "MIDTERM_FAKE_CLAUDE_QA_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            _ = await AppServerControlHostTestClient.ReadHelloAsync(process.StandardOutput);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-attach-qa",
                SessionId = sessionId,
                Type = "runtime.attach",
                AttachRuntime = new AppServerControlAttachRuntimeRequest
                {
                    SessionId = sessionId,
                    Provider = "claude",
                    WorkingDirectory = fakeClaude.Root
                }
            });

            _ = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach-qa");
            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-turn-qa",
                SessionId = sessionId,
                Type = "turn.start",
                StartTurn = new AppServerControlTurnRequest
                {
                    Text = $$"""
                    MIDTERM_CLAUDE_QA_TWO_PHASES
                    FINAL_MARKER={{marker}}

                    Ask exactly two sets of user questions before finishing.
                    """,
                    Attachments = []
                }
            });

            var turnResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn-qa");
            Assert.Equal("accepted", turnResult.Status);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => patch.Patch.RequestUpserts.Any(static request => request.Kind == "interview" && request.State == "open"),
                maxPatches: 20,
                timeout: TimeSpan.FromSeconds(10));

            var firstQuestionWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                sessionId,
                count: 96);
            var firstQuestionRequest = Assert.Single(firstQuestionWindow.Requests, request => request.Kind == "interview" && request.State == "open");
            Assert.Equal(2, firstQuestionRequest.Questions.Count);
            Assert.Equal("waiting_for_input", firstQuestionWindow.Session.State);

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-answer-qa-1",
                SessionId = sessionId,
                Type = "user-input.resolve",
                ResolveUserInput = new AppServerControlUserInputResolutionCommand
                {
                    RequestId = firstQuestionRequest.RequestId,
                    Answers =
                    [
                        new AppServerControlAnsweredQuestion { QuestionId = "language", Answers = ["C#"] },
                        new AppServerControlAnsweredQuestion { QuestionId = "strictness", Answers = ["Strict"] }
                    ]
                }
            });

            var firstAnswerResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-answer-qa-1");
            Assert.Equal("accepted", firstAnswerResult.Status);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => patch.Patch.RequestUpserts.Any(request =>
                    request.Kind == "interview" &&
                    request.State == "open" &&
                    !string.Equals(request.RequestId, firstQuestionRequest.RequestId, StringComparison.Ordinal)),
                maxPatches: 24,
                timeout: TimeSpan.FromSeconds(10));

            var secondQuestionWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
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

            await AppServerControlHostTestClient.WriteCommandAsync(process.StandardInput, new AppServerControlHostCommandEnvelope
            {
                CommandId = "cmd-answer-qa-2",
                SessionId = sessionId,
                Type = "user-input.resolve",
                ResolveUserInput = new AppServerControlUserInputResolutionCommand
                {
                    RequestId = secondQuestionRequest.RequestId,
                    Answers =
                    [
                        new AppServerControlAnsweredQuestion { QuestionId = "output-style", Answers = ["Detailed"] },
                        new AppServerControlAnsweredQuestion { QuestionId = "workspace-scan", Answers = ["Yes"] }
                    ]
                }
            });

            var secondAnswerResult = await AppServerControlHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-answer-qa-2");
            Assert.Equal("accepted", secondAnswerResult.Status);

            _ = await AppServerControlHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.CurrentTurn.State, "completed", StringComparison.Ordinal),
                maxPatches: 12,
                timeout: TimeSpan.FromSeconds(10));

            var resolvedWindow = await AppServerControlHostTestClient.GetHistoryWindowAsync(
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
        return MtAgentHostTestPathResolver.ResolveAgentHostDll(AppContext.BaseDirectory);
    }
}
