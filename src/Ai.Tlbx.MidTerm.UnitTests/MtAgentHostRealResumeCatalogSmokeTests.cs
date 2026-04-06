using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;
using Xunit.Abstractions;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed partial class MtAgentHostRealResumeCatalogSmokeTests
{
    private const string ResumeProbeEnvVar = "MIDTERM_RUN_REAL_RESUME_PROBES";
    private static readonly TimeSpan ActiveCodexSessionCooldown = TimeSpan.FromMinutes(10);
    private readonly ITestOutputHelper _output;

    public MtAgentHostRealResumeCatalogSmokeTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    [Trait("Category", "RealCodex")]
    [Trait("Category", "ResumeProbe")]
    public async Task MtAgentHost_CanResumeRealCodexConversationFromLiveLocalHistory()
    {
        if (!IsRealCodexResumeProbeEnabled())
        {
            return;
        }

        var workingDirectory = ResolveRepoRoot();
        var candidate = TryFindCodexCandidate(workingDirectory);
        if (candidate is null)
        {
            return;
        }

        _output.WriteLine($"Codex resume candidate: {candidate.SessionId} ({candidate.SourcePath})");
        _output.WriteLine($"Codex probe expects prior user message: {candidate.RecentUserMessage}");

        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("codex", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-codex-live-resume",
                SessionId = "session-real-codex-live-resume",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-codex-live-resume",
                    Provider = "codex",
                    WorkingDirectory = candidate.WorkingDirectory,
                    ResumeThreadId = candidate.SessionId
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(
                process.StandardOutput,
                pendingEvents,
                "cmd-attach-real-codex-live-resume");
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = await ReadAttachObservationAsync(
                process.StandardOutput,
                pendingEvents,
                TimeSpan.FromSeconds(8));
            LogEvents("codex attach", attachEvents);

            var threadEvent = Assert.Single(attachEvents, envelope => envelope.Event.Type == "thread.started");
            Assert.Equal(candidate.SessionId, threadEvent.Event.ThreadState?.ProviderThreadId);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-codex-live-resume",
                SessionId = "session-real-codex-live-resume",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text =
                        """
                        Reply with exactly the most recent direct user message in this conversation before this turn.
                        Collapse any internal whitespace to single spaces.
                        Reply with that message only.
                        """,
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(
                process.StandardOutput,
                pendingEvents,
                "cmd-turn-real-codex-live-resume");
            Assert.Equal("accepted", turnResult.Status);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 160);
            LogEvents("codex turn", turnEvents);

            var assistantText = CollectAssistantText(turnEvents);
            _output.WriteLine($"Codex resumed assistant text: {NormalizeMessage(assistantText)}");
            AssertNormalizedMessageMatch(candidate.RecentUserMessage, assistantText);
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
    [Trait("Category", "RealClaude")]
    [Trait("Category", "ResumeProbe")]
    public async Task MtAgentHost_CanResumeRealClaudeConversationFromLiveLocalHistory()
    {
        if (!IsRealClaudeResumeProbeEnabled())
        {
            return;
        }

        var workingDirectory = ResolveRepoRoot();
        var candidate = TryFindClaudeCandidate(workingDirectory);
        if (candidate is null)
        {
            return;
        }

        _output.WriteLine($"Claude resume candidate: {candidate.SessionId} ({candidate.SourcePath})");
        _output.WriteLine($"Claude probe expects prior user message: {candidate.RecentUserMessage}");

        var hostDll = ResolveAgentHostDll();
        using var process = StartAgentHost(hostDll, configureClaudePermissions: true);
        var pendingEvents = new Queue<LensHostEventEnvelope>();

        try
        {
            var hello = await LensHostTestClient.ReadHelloAsync(process.StandardOutput);
            Assert.Contains("claude", hello.Providers);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-attach-real-claude-live-resume",
                SessionId = "session-real-claude-live-resume",
                Type = "runtime.attach",
                AttachRuntime = new LensAttachRuntimeRequest
                {
                    SessionId = "session-real-claude-live-resume",
                    Provider = "claude",
                    WorkingDirectory = candidate.WorkingDirectory,
                    ResumeThreadId = candidate.SessionId
                }
            });

            var attachResult = await LensHostTestClient.ReadResultAsync(
                process.StandardOutput,
                pendingEvents,
                "cmd-attach-real-claude-live-resume");
            Assert.Equal("accepted", attachResult.Status);

            var attachEvents = await ReadAttachObservationAsync(
                process.StandardOutput,
                pendingEvents,
                TimeSpan.FromSeconds(8));
            LogEvents("claude attach", attachEvents);

            var threadEvent = Assert.Single(attachEvents, envelope => envelope.Event.Type == "thread.started");
            Assert.Equal(candidate.SessionId, threadEvent.Event.ThreadState?.ProviderThreadId);

            await LensHostTestClient.WriteCommandAsync(process.StandardInput, new LensHostCommandEnvelope
            {
                CommandId = "cmd-turn-real-claude-live-resume",
                SessionId = "session-real-claude-live-resume",
                Type = "turn.start",
                StartTurn = new LensTurnRequest
                {
                    Text =
                        """
                        Reply with exactly the most recent direct user message in this conversation before this turn.
                        Collapse any internal whitespace to single spaces.
                        Reply with that message only.
                        """,
                    Attachments = []
                }
            });

            var turnResult = await LensHostTestClient.ReadResultAsync(
                process.StandardOutput,
                pendingEvents,
                "cmd-turn-real-claude-live-resume");
            Assert.Equal("accepted", turnResult.Status);

            var turnEvents = await LensHostTestClient.ReadUntilAsync(
                process.StandardOutput,
                pendingEvents,
                envelope => envelope.Event.Type == "turn.completed",
                maxEvents: 220);
            LogEvents("claude turn", turnEvents);

            var assistantText = CollectAssistantText(turnEvents);
            _output.WriteLine($"Claude resumed assistant text: {NormalizeMessage(assistantText)}");
            AssertNormalizedMessageMatch(candidate.RecentUserMessage, assistantText);
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

    private static ResumeProbeCandidate? TryFindCodexCandidate(string workingDirectory)
    {
        var targetDirectory = NormalizePath(workingDirectory);
        var cutoff = DateTime.UtcNow - ActiveCodexSessionCooldown;
        var sessionsRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "sessions");
        if (!Directory.Exists(sessionsRoot))
        {
            return null;
        }

        foreach (var path in Directory.EnumerateFiles(sessionsRoot, "*.jsonl", SearchOption.AllDirectories)
                     .Select(static path => new FileInfo(path))
                     .Where(file => file.LastWriteTimeUtc <= cutoff)
                     .OrderByDescending(static file => file.LastWriteTimeUtc)
                     .Take(400)
                     .Select(static file => file.FullName))
        {
            if (!TryReadCodexSessionMeta(path, out var sessionId, out var cwd) ||
                string.IsNullOrWhiteSpace(cwd) ||
                !string.Equals(NormalizePath(cwd), targetDirectory, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var recentUserMessage = TryReadLastCodexDirectUserMessage(path);
            if (IsUsableResumeProbeMessage(recentUserMessage))
            {
                return new ResumeProbeCandidate(sessionId!, cwd, NormalizeMessage(recentUserMessage!), path);
            }
        }

        return null;
    }

    private static ResumeProbeCandidate? TryFindClaudeCandidate(string workingDirectory)
    {
        var targetDirectory = NormalizePath(workingDirectory);
        var projectsRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "projects");
        if (!Directory.Exists(projectsRoot))
        {
            return null;
        }

        foreach (var path in Directory.EnumerateFiles(projectsRoot, "*.jsonl", SearchOption.AllDirectories)
                     .Where(static path => !path.Contains($"{Path.DirectorySeparatorChar}subagents{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
                     .Select(static path => new FileInfo(path))
                     .OrderByDescending(static file => file.LastWriteTimeUtc)
                     .Take(200)
                     .Select(static file => file.FullName))
        {
            if (!TryReadClaudeSessionProbeData(path, targetDirectory, out var sessionId, out var cwd, out var recentUserMessage))
            {
                continue;
            }

            return new ResumeProbeCandidate(sessionId!, cwd!, NormalizeMessage(recentUserMessage!), path);
        }

        return null;
    }

    private static bool TryReadCodexSessionMeta(string path, out string? sessionId, out string? cwd)
    {
        sessionId = null;
        cwd = null;

        using var reader = OpenSharedReaderOrNull(path);
        if (reader is null)
        {
            return false;
        }

        try
        {
            var firstLine = reader.ReadLine();
            if (string.IsNullOrWhiteSpace(firstLine))
            {
                return false;
            }

            using var json = JsonDocument.Parse(firstLine);
            var root = json.RootElement;
            if (!string.Equals(root.GetProperty("type").GetString(), "session_meta", StringComparison.Ordinal))
            {
                return false;
            }

            var payload = root.GetProperty("payload");
            sessionId = payload.GetProperty("id").GetString();
            cwd = payload.GetProperty("cwd").GetString();
            return !string.IsNullOrWhiteSpace(sessionId) && !string.IsNullOrWhiteSpace(cwd);
        }
        catch
        {
            return false;
        }
    }

    private static string? TryReadLastCodexDirectUserMessage(string path)
    {
        using var reader = OpenSharedReaderOrNull(path);
        if (reader is null)
        {
            return null;
        }

        string? lastDirectMessage = null;

        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                if (!TryGetString(root, "type", out var rootType) ||
                    !string.Equals(rootType, "response_item", StringComparison.Ordinal))
                {
                    continue;
                }

                if (!root.TryGetProperty("payload", out var payload) ||
                    payload.ValueKind != JsonValueKind.Object ||
                    !TryGetString(payload, "type", out var payloadType) ||
                    !string.Equals(payloadType, "message", StringComparison.Ordinal) ||
                    !TryGetString(payload, "role", out var role) ||
                    !string.Equals(role, "user", StringComparison.Ordinal))
                {
                    continue;
                }

                if (!payload.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var item in content.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object ||
                        !TryGetString(item, "type", out var itemType) ||
                        !string.Equals(itemType, "input_text", StringComparison.Ordinal) ||
                        !TryGetString(item, "text", out var text))
                    {
                        continue;
                    }

                    if (IsUsableResumeProbeMessage(text))
                    {
                        lastDirectMessage = text;
                    }
                }
            }
            catch
            {
            }
        }

        return lastDirectMessage;
    }

    private static bool TryReadClaudeSessionProbeData(
        string path,
        string targetDirectory,
        out string? sessionId,
        out string? cwd,
        out string? recentUserMessage)
    {
        sessionId = null;
        cwd = null;
        recentUserMessage = null;
        var matchesTargetDirectory = false;

        using var reader = OpenSharedReaderOrNull(path);
        if (reader is null)
        {
            return false;
        }

        while (reader.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;

                if (TryGetString(root, "cwd", out var lineCwd))
                {
                    cwd = lineCwd;
                    if (string.Equals(NormalizePath(lineCwd!), targetDirectory, StringComparison.OrdinalIgnoreCase))
                    {
                        matchesTargetDirectory = true;
                    }
                }

                if (TryGetString(root, "sessionId", out var lineSessionId))
                {
                    sessionId = lineSessionId;
                }

                if (!matchesTargetDirectory ||
                    !TryGetString(root, "type", out var rootType) ||
                    !string.Equals(rootType, "user", StringComparison.Ordinal) ||
                    !root.TryGetProperty("message", out var message) ||
                    message.ValueKind != JsonValueKind.Object ||
                    !TryGetString(message, "role", out var role) ||
                    !string.Equals(role, "user", StringComparison.Ordinal))
                {
                    continue;
                }

                var text = TryReadClaudeDirectUserMessageText(message);
                if (IsUsableResumeProbeMessage(text))
                {
                    recentUserMessage = text;
                }
            }
            catch
            {
            }
        }

        return matchesTargetDirectory &&
               !string.IsNullOrWhiteSpace(sessionId) &&
               !string.IsNullOrWhiteSpace(cwd) &&
               IsUsableResumeProbeMessage(recentUserMessage);
    }

    private static string? TryReadClaudeDirectUserMessageText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var content))
        {
            return null;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString();
        }

        if (content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var parts = new List<string>();
        foreach (var item in content.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object ||
                !TryGetString(item, "type", out var itemType) ||
                !string.Equals(itemType, "text", StringComparison.Ordinal) ||
                !TryGetString(item, "text", out var text))
            {
                continue;
            }

            parts.Add(text!);
        }

        return parts.Count == 0 ? null : string.Join(" ", parts);
    }

    private static bool IsUsableResumeProbeMessage(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        var normalized = NormalizeMessage(text);
        if (normalized.Length < 8 || normalized.Length > 180)
        {
            return false;
        }

        if (normalized.Contains("AGENTS.md instructions", StringComparison.OrdinalIgnoreCase) ||
            normalized.Contains("<environment_context>", StringComparison.OrdinalIgnoreCase) ||
            normalized.Contains("[Request interrupted", StringComparison.OrdinalIgnoreCase) ||
            normalized.Contains("Reply with exactly the most recent direct user message", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var words = Tokenize(normalized);
        return words.Count is >= 2 and <= 24;
    }

    private static void AssertNormalizedMessageMatch(string expected, string actual)
    {
        var normalizedExpected = NormalizeMessage(expected);
        var normalizedActual = NormalizeMessage(actual)
            .Trim('"')
            .Trim('\'')
            .Trim('`');

        Assert.Equal(normalizedExpected, normalizedActual);
    }

    private static string CollectAssistantText(IEnumerable<LensHostEventEnvelope> events)
    {
        var completedAssistantMessages = events
            .Where(static envelope =>
                envelope.Event.Type == "item.completed" &&
                string.Equals(envelope.Event.Item?.ItemType, "assistant_message", StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(envelope.Event.Item?.Detail))
            .Select(static envelope => envelope.Event.Item!.Detail!)
            .ToList();

        if (completedAssistantMessages.Count > 0)
        {
            return string.Join(Environment.NewLine, completedAssistantMessages);
        }

        return string.Concat(
            events
                .Where(static envelope =>
                    envelope.Event.Type == "content.delta" &&
                    string.Equals(envelope.Event.ContentDelta?.StreamKind, "assistant_text", StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(envelope.Event.ContentDelta?.Delta))
                .Select(static envelope => envelope.Event.ContentDelta!.Delta));
    }

    private static List<string> Tokenize(string text)
    {
        return NonWhitespaceRegex().Matches(text)
            .Select(static match => match.Value)
            .ToList();
    }

    private static string NormalizeMessage(string text)
    {
        return WhitespaceRegex().Replace(text, " ").Trim();
    }

    private static string NormalizePath(string path)
    {
        return Path.GetFullPath(path)
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static bool TryGetString(JsonElement element, string propertyName, out string? value)
    {
        value = null;
        if (!element.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = property.GetString();
        return !string.IsNullOrWhiteSpace(value);
    }

    private static StreamReader? OpenSharedReaderOrNull(string path)
    {
        try
        {
            var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            return new StreamReader(stream);
        }
        catch
        {
            return null;
        }
    }

    private async Task<IReadOnlyList<LensHostEventEnvelope>> ReadAttachObservationAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents,
        TimeSpan timeout)
    {
        var events = new List<LensHostEventEnvelope>();
        var deadline = DateTimeOffset.UtcNow + timeout;
        var sawReady = false;
        var sawThreadStarted = false;

        while (events.Count < 12 && (!sawReady || !sawThreadStarted))
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            var envelope = await LensHostTestClient.ReadEventAsync(reader, pendingEvents, remaining);
            events.Add(envelope);
            sawReady |= string.Equals(envelope.Event.Type, "session.ready", StringComparison.Ordinal);
            sawThreadStarted |= string.Equals(envelope.Event.Type, "thread.started", StringComparison.Ordinal);
        }

        return events;
    }

    private void LogEvents(string label, IEnumerable<LensHostEventEnvelope> events)
    {
        foreach (var envelope in events)
        {
            _output.WriteLine(
                $"{label}: {envelope.Event.Type} " +
                $"thread={envelope.Event.ThreadState?.ProviderThreadId ?? "<none>"} " +
                $"stream={envelope.Event.ContentDelta?.StreamKind ?? "<none>"} " +
                $"item={envelope.Event.Item?.ItemType ?? "<none>"} " +
                $"reason={envelope.Event.SessionState?.Reason ?? "<none>"}");
        }
    }

    private static bool IsRealCodexResumeProbeEnabled()
    {
        return IsProbeEnabled() && ResolveCodexOnPath() is not null;
    }

    private static bool IsRealClaudeResumeProbeEnabled()
    {
        return IsProbeEnabled() && ResolveClaudeOnPath() is not null;
    }

    private static bool IsProbeEnabled()
    {
        return string.Equals(Environment.GetEnvironmentVariable(ResumeProbeEnvVar), "1", StringComparison.Ordinal);
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

    private static Process StartAgentHost(string hostDll, bool configureClaudePermissions = false)
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

        if (configureClaudePermissions)
        {
            process.StartInfo.Environment["MIDTERM_LENS_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS"] = "true";
        }

        process.Start();
        return process;
    }

    private static string ResolveAgentHostDll()
    {
        var repoRoot = ResolveRepoRoot();
        var candidates = new[]
        {
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "mtagenthost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "win-x64", "Ai.Tlbx.MidTerm.AgentHost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "mtagenthost.dll"),
            Path.Combine(repoRoot, "src", "Ai.Tlbx.MidTerm.AgentHost", "bin", "Debug", "net10.0", "Ai.Tlbx.MidTerm.AgentHost.dll")
        };

        return candidates.First(File.Exists);
    }

    private static string ResolveRepoRoot()
    {
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
    }

    [GeneratedRegex(@"\S+", RegexOptions.CultureInvariant)]
    private static partial Regex NonWhitespaceRegex();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRegex();

    private sealed record ResumeProbeCandidate(
        string SessionId,
        string WorkingDirectory,
        string RecentUserMessage,
        string SourcePath);
}
