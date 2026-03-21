using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MtAgentHostRealCodexSmokeTests
{
    [Fact]
    [Trait("Category", "RealCodex")]
    public async Task MtAgentHost_CanAttachAndCompleteRealCodexTurn()
    {
        if (!IsRealCodexSmokeEnabled())
        {
            return;
        }

        var hostDll = ResolveAgentHostDll();
        var workdir = Path.Combine(Path.GetTempPath(), "midterm-real-codex-smoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workdir);

        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        var marker = "MIDTERM_REAL_CODEX_SMOKE_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Equal(LensHostProtocol.CurrentVersion, hello.ProtocolVersion);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real",
                SessionId = "session-real-codex",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-codex",
                    Provider = "codex",
                    WorkingDirectory = workdir
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-real");
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 8);
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "thread.started");
            Assert.Contains(attachEvents, envelope => envelope.Event.Type == "session.ready");

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real",
                SessionId = "session-real-codex",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $"Reply with exactly {marker} and nothing else.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real");
            Assert.Equal("accepted", turnResult.Status);
            Assert.NotNull(turnResult.TurnStarted);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 40);
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.started");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.completed");
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" ||
                            envelope.Event.Type == "item.started" ||
                            envelope.Event.Type == "item.completed");
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
                // Ignore temp-dir cleanup failures in the smoke test.
            }
        }
    }

    [Fact]
    [Trait("Category", "RealCodex")]
    public async Task MtAgentHost_CanAttachToRealCodexWebSocketAppServer()
    {
        if (!IsRealCodexSmokeEnabled())
        {
            return;
        }

        var hostDll = ResolveAgentHostDll();
        var workdir = Path.Combine(Path.GetTempPath(), "midterm-real-codex-remote-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workdir);
        var port = GetFreePort();
        var appServerEndpoint = $"ws://127.0.0.1:{port}";
        using var appServer = StartCodexAppServer(appServerEndpoint);
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();
        var marker = "MIDTERM_REAL_CODEX_REMOTE_" + Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();

        try
        {
            await WaitForCodexAppServerReadyAsync(port);

            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Equal(LensHostProtocol.CurrentVersion, hello.ProtocolVersion);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-remote",
                SessionId = "session-real-codex-remote",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-codex-remote",
                    Provider = "codex",
                    WorkingDirectory = workdir,
                    AttachPoint = new SessionAgentAttachPoint
                    {
                        Provider = SessionAgentAttachPoint.CodexProvider,
                        TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                        Endpoint = appServerEndpoint,
                        SharedRuntime = true,
                        Source = "real-smoke"
                    }
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-attach-real-remote");
            Assert.Equal("accepted", attachResult.Status);

            _ = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "session.ready",
                maxEvents: 8);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-remote",
                SessionId = "session-real-codex-remote",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text = $"Reply with exactly {marker} and nothing else.",
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(process.StandardOutput, pendingEvents, "cmd-turn-real-remote");
            Assert.Equal("accepted", turnResult.Status);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 40);
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.started");
            Assert.Contains(turnEvents, envelope => envelope.Event.Type == "turn.completed");
            Assert.Contains(
                turnEvents,
                envelope => envelope.Event.Type == "content.delta" ||
                            envelope.Event.Type == "item.started" ||
                            envelope.Event.Type == "item.completed");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }

            if (!appServer.HasExited)
            {
                appServer.Kill(entireProcessTree: true);
            }

            _ = await process.StandardError.ReadToEndAsync();
            _ = await appServer.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();
            await appServer.WaitForExitAsync();

            try
            {
                Directory.Delete(workdir, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static bool IsRealCodexSmokeEnabled()
    {
        var enabled = Environment.GetEnvironmentVariable("MIDTERM_RUN_REAL_CODEX_TESTS");
        if (!string.Equals(enabled, "1", StringComparison.Ordinal))
        {
            return false;
        }

        if (ResolveCodexOnPath() is null)
        {
            return false;
        }

        return true;
    }

    private static string? ResolveCodexOnPath()
    {
        var path = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        foreach (var entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var cmd = Path.Combine(entry, "codex.cmd");
            if (File.Exists(cmd))
            {
                return cmd;
            }

            var exe = Path.Combine(entry, "codex.exe");
            if (File.Exists(exe))
            {
                return exe;
            }

            var bare = Path.Combine(entry, "codex");
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
        process.Start();
        return process;
    }

    private static Process StartCodexAppServer(string endpoint)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = OperatingSystem.IsWindows() ? "pwsh" : ResolveCodexOnPath() ?? "codex",
                Arguments = OperatingSystem.IsWindows()
                    ? $"-NoProfile -Command \"codex app-server --listen {endpoint}\""
                    : $"app-server --listen {endpoint}",
                RedirectStandardInput = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };
        process.Start();
        return process;
    }

    private static async Task WaitForCodexAppServerReadyAsync(int port)
    {
        using var client = new HttpClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        while (true)
        {
            cts.Token.ThrowIfCancellationRequested();
            try
            {
                using var response = await client.GetAsync($"http://127.0.0.1:{port}/readyz", cts.Token);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch (HttpRequestException)
            {
            }

            await Task.Delay(200, cts.Token);
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

    private static int GetFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
