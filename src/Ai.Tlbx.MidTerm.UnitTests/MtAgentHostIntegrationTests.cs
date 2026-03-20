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
                    WorkingDirectory = "Q:\\repos\\MidtermJpa"
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach");
            Assert.Equal("cmd-attach", attachResult.CommandId);
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = await LensHostTestClient.ReadEventsAsync(process.StandardOutput, pendingEvents, 3);
            Assert.Collection(
                attachEvents,
                first => Assert.Equal("session.started", first.Event.Type),
                second => Assert.Equal("session.ready", second.Event.Type),
                third => Assert.Equal("thread.started", third.Event.Type));

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

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn");
            Assert.NotNull(turnResult.TurnStarted);
            Assert.Equal("started", turnResult.TurnStarted!.Status);

            var turnEvents = await LensHostTestClient.ReadEventsAsync(process.StandardOutput, pendingEvents, 8);
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "content.delta" && envelope.Event.ContentDelta?.StreamKind == "assistant_text");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "content.delta" && envelope.Event.ContentDelta?.StreamKind == "reasoning_text");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "plan.completed");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "diff.updated");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "request.opened");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-resolve",
                SessionId = "session-1",
                Type = "request.resolve",
                ResolveRequest = new LensRequestResolutionCommand
                {
                    RequestId = "req-approval-1",
                    Decision = "accept"
                }
            });

            var resolveResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-resolve");
            Assert.Equal("accepted", resolveResult.Status);

            var resolveEvent = await LensHostTestClient.ReadEventAsync(process.StandardOutput, pendingEvents);
            Assert.Equal("request.resolved", resolveEvent.Event.Type);
            Assert.Equal("accept", resolveEvent.Event.RequestResolved?.Decision);
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
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "mtagenthost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "Ai.Tlbx.MidTerm.AgentHost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "mtagenthost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "Ai.Tlbx.MidTerm.AgentHost.dll")
        };

        return candidates.First(File.Exists);
    }
}
