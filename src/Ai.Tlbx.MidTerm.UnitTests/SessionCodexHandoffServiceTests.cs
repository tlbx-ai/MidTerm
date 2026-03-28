using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionCodexHandoffServiceTests : IDisposable
{
    private readonly string _tempRoot = Path.Combine(Path.GetTempPath(), "midterm-codex-handoff-tests", Guid.NewGuid().ToString("N"));

    public SessionCodexHandoffServiceTests()
    {
        Directory.CreateDirectory(_tempRoot);
    }

    [Fact]
    public void TryExtractResumeThreadId_ReadsResumeArgument()
    {
        var resumeThreadId = SessionCodexHandoffService.TryExtractResumeThreadId(
            "\"C:\\Users\\johan\\AppData\\Roaming\\npm\\codex.cmd\" --yolo resume 019d127e-71ac-78d2-b934-12c6431b0d5c");

        Assert.Equal("019d127e-71ac-78d2-b934-12c6431b0d5c", resumeThreadId);
    }

    [Fact]
    public void BuildResumeLaunchCommand_AppendsResumeSubcommand()
    {
        var command = SessionCodexHandoffService.BuildResumeLaunchCommand(
            "codex --yolo --no-alt-screen",
            "019d127e-71ac-78d2-b934-12c6431b0d5c");

        Assert.Equal("codex --yolo --no-alt-screen resume 019d127e-71ac-78d2-b934-12c6431b0d5c", command);
    }

    [Fact]
    public void LooksLikeCodexForeground_MatchesDerivedSessionIdentity()
    {
        var session = new SessionInfoDto
        {
            ForegroundProcessIdentity = "codex"
        };
        var looksLikeCodex = SessionCodexHandoffService.LooksLikeCodexForeground(session);

        Assert.True(looksLikeCodex);
    }

    [Fact]
    public void IsShellForeground_AcceptsGenericShellIdentity()
    {
        var isShell = SessionCodexHandoffService.IsShellForeground("shell", "Pwsh");

        Assert.True(isShell);
    }

    [Fact]
    public void ForegroundProcessService_MatchesWrapperCommandLine()
    {
        var service = new SessionForegroundProcessService();
        var descriptor = service.Describe(
            processName: "node.exe",
            commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\repo\\node_modules\\@openai\\codex\\bin\\codex.js\" --yolo",
            attachPoint: null);

        Assert.Equal("codex --yolo", descriptor.DisplayName);
        Assert.Equal("codex", descriptor.ProcessIdentity);
    }

    [Fact]
    public void ForegroundProcessService_PrefersAttachPointProviderForIdentity()
    {
        var service = new SessionForegroundProcessService();
        var descriptor = service.Describe(
            processName: "node.exe",
            commandLine: "node cli.js",
            attachPoint: new SessionAgentAttachPoint
            {
                Provider = SessionAgentAttachPoint.CodexProvider,
                TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
                Endpoint = "ws://127.0.0.1:1234"
            });

        Assert.Equal("codex", descriptor.ProcessIdentity);
    }

    [Fact]
    public void ForegroundProcessService_UnwrapsPwshCodexWrapper()
    {
        var service = new SessionForegroundProcessService();
        var descriptor = service.Describe(
            processName: "pwsh.exe",
            commandLine: "pwsh -NoLogo -File C:\\Users\\johan\\AppData\\Roaming\\npm\\codex.ps1 --yolo",
            attachPoint: null);

        Assert.Equal("codex --yolo", descriptor.DisplayName);
        Assert.Equal("codex", descriptor.ProcessIdentity);
    }

    [Fact]
    public void ForegroundProcessService_UnwrapsCmdCodexWrapper()
    {
        var service = new SessionForegroundProcessService();
        var descriptor = service.Describe(
            processName: "cmd.exe",
            commandLine: "cmd /d /s /c C:\\Users\\johan\\AppData\\Roaming\\npm\\codex.cmd --yolo",
            attachPoint: null);

        Assert.Equal("codex --yolo", descriptor.DisplayName);
        Assert.Equal("codex", descriptor.ProcessIdentity);
    }

    [Fact]
    public async Task ResolveResumeThreadIdAsync_UsesUniqueDiskMatchForSessionCwd()
    {
        var cwd = Path.Combine(_tempRoot, "repo");
        Directory.CreateDirectory(cwd);
        WriteSessionMeta(
            sessionId: "thread-candidate-1",
            cwd,
            timestamp: new DateTimeOffset(2026, 3, 21, 22, 21, 21, TimeSpan.Zero));
        WriteSessionMeta(
            sessionId: "thread-other-cwd",
            Path.Combine(_tempRoot, "other"),
            timestamp: new DateTimeOffset(2026, 3, 21, 22, 21, 22, TimeSpan.Zero));

        var service = CreateService();
        var session = new SessionInfoDto
        {
            Id = "s1",
            CurrentDirectory = cwd,
            CreatedAt = new DateTime(2026, 3, 21, 22, 20, 0, DateTimeKind.Utc)
        };

        var resumeThreadId = await service.ResolveResumeThreadIdAsync(session, CancellationToken.None);

        Assert.Equal("thread-candidate-1", resumeThreadId);
    }

    [Fact]
    public async Task ResolveResumeThreadIdAsync_UsesCanonicalLensSnapshotThreadId()
    {
        var cwd = Path.Combine(_tempRoot, "repo-snapshot");
        Directory.CreateDirectory(cwd);
        var service = CreateService(out var pulse);
        pulse.Append(new LensPulseEvent
        {
            EventId = "evt-session-started",
            SessionId = "s-snapshot",
            Provider = "codex",
            CreatedAt = new DateTimeOffset(2026, 3, 23, 21, 6, 51, TimeSpan.Zero),
            Type = "session.started",
            SessionState = new LensPulseSessionStatePayload
            {
                State = "starting",
                StateLabel = "Starting",
                Reason = "Lens runtime attached."
            }
        });
        pulse.Append(new LensPulseEvent
        {
            EventId = "evt-thread-started",
            SessionId = "s-snapshot",
            Provider = "codex",
            CreatedAt = new DateTimeOffset(2026, 3, 23, 21, 6, 52, TimeSpan.Zero),
            Type = "thread.started",
            ThreadState = new LensPulseThreadStatePayload
            {
                State = "active",
                StateLabel = "Active",
                ProviderThreadId = "thread-from-snapshot"
            }
        });

        var session = new SessionInfoDto
        {
            Id = "s-snapshot",
            CurrentDirectory = cwd,
            CreatedAt = new DateTime(2026, 3, 23, 21, 5, 0, DateTimeKind.Utc)
        };

        var resumeThreadId = await service.ResolveResumeThreadIdAsync(session, CancellationToken.None);

        Assert.Equal("thread-from-snapshot", resumeThreadId);
        Assert.True(service.TryGetKnownResumeThreadId("s-snapshot", out var rememberedThreadId));
        Assert.Equal("thread-from-snapshot", rememberedThreadId);
    }

    [Fact]
    public async Task ResolveResumeThreadIdAsync_UsesRecentFileActivityWhenSessionMetaTimestampIsOld()
    {
        var cwd = Path.Combine(_tempRoot, "repo-active");
        Directory.CreateDirectory(cwd);
        var activeFile = WriteSessionMeta(
            sessionId: "thread-active",
            cwd,
            timestamp: new DateTimeOffset(2026, 3, 22, 23, 35, 40, TimeSpan.Zero));
        File.SetLastWriteTimeUtc(activeFile, new DateTime(2026, 3, 23, 21, 49, 4, DateTimeKind.Utc));
        var staleFile = WriteSessionMeta(
            sessionId: "thread-stale",
            cwd,
            timestamp: new DateTimeOffset(2026, 3, 23, 21, 6, 51, TimeSpan.Zero));
        File.SetLastWriteTimeUtc(staleFile, new DateTime(2026, 3, 23, 21, 40, 32, DateTimeKind.Utc));

        var service = CreateService();
        var session = new SessionInfoDto
        {
            Id = "s-active",
            CurrentDirectory = cwd,
            CreatedAt = new DateTime(2026, 3, 23, 21, 48, 41, DateTimeKind.Utc)
        };

        var resumeThreadId = await service.ResolveResumeThreadIdAsync(session, CancellationToken.None);

        Assert.Equal("thread-active", resumeThreadId);
    }

    [Fact]
    public async Task ResolveResumeThreadIdAsync_RejectsAmbiguousDiskMatches()
    {
        var cwd = Path.Combine(_tempRoot, "repo-ambiguous");
        Directory.CreateDirectory(cwd);
        WriteSessionMeta(
            sessionId: "thread-candidate-1",
            cwd,
            timestamp: new DateTimeOffset(2026, 3, 21, 22, 21, 21, TimeSpan.Zero));
        WriteSessionMeta(
            sessionId: "thread-candidate-2",
            cwd,
            timestamp: new DateTimeOffset(2026, 3, 21, 22, 21, 22, TimeSpan.Zero));

        var service = CreateService();
        var session = new SessionInfoDto
        {
            Id = "s2",
            CurrentDirectory = cwd,
            CreatedAt = new DateTime(2026, 3, 21, 22, 20, 0, DateTimeKind.Utc)
        };

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => service.ResolveResumeThreadIdAsync(session, CancellationToken.None));
        Assert.Equal("MidTerm could not determine the Codex resume id for this session.", error.Message);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempRoot))
            {
                Directory.Delete(_tempRoot, recursive: true);
            }
        }
        catch
        {
        }
    }

    private SessionCodexHandoffService CreateService(out SessionLensPulseService pulse)
    {
        pulse = new SessionLensPulseService();
        var ingress = new SessionLensHostIngressService(pulse);
        var hostRuntime = new SessionLensHostRuntimeService(ingress, pulse, new SettingsService(), mode: "off");
        var sessionManager = new TtyHostSessionManager();
        var lensRuntime = new SessionLensRuntimeService(sessionManager, new AiCliProfileService(), pulse, hostRuntime);
        var foregroundProcessService = new SessionForegroundProcessService();
        return new SessionCodexHandoffService(
            sessionManager,
            new WorkerSessionRegistryService(),
            new AiCliProfileService(),
            foregroundProcessService,
            pulse,
            lensRuntime,
            _tempRoot);
    }

    private SessionCodexHandoffService CreateService()
    {
        return CreateService(out _);
    }

    private string WriteSessionMeta(string sessionId, string cwd, DateTimeOffset timestamp)
    {
        Directory.CreateDirectory(cwd);
        var datePath = Path.Combine(_tempRoot, "sessions", timestamp.ToString("yyyy", null), timestamp.ToString("MM", null), timestamp.ToString("dd", null));
        Directory.CreateDirectory(datePath);
        var filePath = Path.Combine(datePath, $"rollout-{timestamp:yyyy-MM-ddTHH-mm-ss}-{sessionId}.jsonl");
        var payload = JsonSerializer.Serialize(new
        {
            timestamp,
            type = "session_meta",
            payload = new
            {
                id = sessionId,
                timestamp,
                cwd
            }
        });
        File.WriteAllText(filePath, payload, Encoding.UTF8);
        return filePath;
    }
}
