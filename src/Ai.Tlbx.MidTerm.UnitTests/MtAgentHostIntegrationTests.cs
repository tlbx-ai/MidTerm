using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MtAgentHostIntegrationTests
{
    [Fact]
    public async Task SyntheticMtAgentHost_StreamsTypedLensProtocolOverStdio()
    {
        var hostDll = ResolveAgentHostDll();
        Assert.True(File.Exists(hostDll), $"Expected mtagenthost build output at '{hostDll}'.");

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "dotnet",
                Arguments = $"\"{hostDll}\" --stdio --synthetic codex",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        process.Start();
        var pendingPatches = new Queue<LensHostHistoryPatchEnvelope>();

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
                    WorkingDirectory = "Q:\\repos\\MidtermJpa"
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-attach");
            Assert.Equal("cmd-attach", attachResult.CommandId);
            Assert.Equal("accepted", attachResult.Status);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => string.Equals(patch.Patch.Session.State, "ready", StringComparison.Ordinal) &&
                         !string.IsNullOrWhiteSpace(patch.Patch.Thread.ThreadId),
                maxPatches: 4,
                timeout: TimeSpan.FromSeconds(10));

            var attachWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-1",
                count: 16);
            Assert.Equal("ready", attachWindow.Session.State);
            Assert.Equal("active", attachWindow.Thread.State);
            Assert.False(string.IsNullOrWhiteSpace(attachWindow.Thread.ThreadId));

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn",
                SessionId = "session-1",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = "Inspect the repo and propose a patch.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-turn");
            Assert.NotNull(turnResult.TurnStarted);
            Assert.Equal("accepted", turnResult.TurnStarted!.Status);

            _ = await LensHostTestClient.ReadUntilMatchAsync(
                process.StandardOutput,
                pendingPatches,
                patch => patch.Patch.RequestUpserts.Count > 0,
                maxPatches: 12,
                timeout: TimeSpan.FromSeconds(10));

            var turnWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-1",
                count: 64);
            Assert.Contains(turnWindow.History, item => item.ItemType == "user_message");
            Assert.Contains("Synthetic codex reply", turnWindow.Streams.AssistantText, StringComparison.Ordinal);
            Assert.Contains("Inspecting workspace", turnWindow.Streams.ReasoningText, StringComparison.Ordinal);
            Assert.Contains("1. Read the repo.", turnWindow.Streams.PlanText, StringComparison.Ordinal);
            Assert.Contains("--- a/file.txt", turnWindow.Streams.UnifiedDiff, StringComparison.Ordinal);
            var request = Assert.Single(turnWindow.Requests);
            Assert.Equal("approval", request.Kind);
            Assert.Equal("open", request.State);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-resolve",
                SessionId = "session-1",
                Type = "request.resolve",
                ResolveRequest = new LensRequestResolutionCommand
                {
                    RequestId = request.RequestId,
                    Decision = "accept"
                }
            });

            var resolveResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingPatches, "cmd-resolve");
            Assert.Equal("accepted", resolveResult.Status);

            var resolveWindow = await LensHostTestClient.GetHistoryWindowAsync(
                process.StandardOutput,
                process.StandardInput,
                pendingPatches,
                "session-1",
                count: 64);
            Assert.Equal("running", resolveWindow.CurrentTurn.State);
            Assert.Contains(resolveWindow.Requests, entry => entry.RequestId == request.RequestId && entry.Decision == "accept");
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
