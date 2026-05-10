using System.Text;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ProviderResumeCatalogServiceTests : IDisposable
{
    private readonly string _root;

    public ProviderResumeCatalogServiceTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "midterm-provider-resume-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    [Fact]
    public void GetCandidates_ReadsCodexSessionsFromLocalStorage()
    {
        var workingDirectory = Path.Combine(_root, "repos", "MidTermWorkspace3");
        Directory.CreateDirectory(workingDirectory);

        var sessionPath = Path.Combine(_root, ".codex", "sessions", "2026", "04", "06", "codex-1.jsonl");
        Directory.CreateDirectory(Path.GetDirectoryName(sessionPath)!);
        File.WriteAllText(
            sessionPath,
            string.Join(
                Environment.NewLine,
                """
                {"type":"session_meta","payload":{"id":"thread-codex-1","cwd":"__CWD__","timestamp":"2026-04-06T12:00:00Z"}}
                {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Continue the MidTerm bookmark resume flow"}]}}
                """.Replace("__CWD__", EscapeJson(workingDirectory), StringComparison.Ordinal)),
            Encoding.UTF8);
        File.SetLastWriteTimeUtc(sessionPath, new DateTime(2026, 4, 6, 12, 5, 0, DateTimeKind.Utc));

        var service = new ProviderResumeCatalogService(_root);

        var candidates = service.GetCandidates("codex", workingDirectory, includeAllDirectories: false);

        var candidate = Assert.Single(candidates);
        Assert.Equal("codex", candidate.Provider);
        Assert.Equal("thread-codex-1", candidate.SessionId);
        Assert.Equal(workingDirectory, candidate.WorkingDirectory);
        Assert.True(candidate.Title.Contains("Continue the MidTerm bookmark resume flow", StringComparison.Ordinal));
    }

    [Fact]
    public void GetCandidates_ReadsClaudeSessionsFromProjectStorage()
    {
        var workingDirectory = Path.Combine(_root, "repos", "MidTermWorkspace3");
        Directory.CreateDirectory(workingDirectory);

        var projectPath = Path.Combine(_root, ".claude", "projects", "Q--repos-MidTermWorkspace3", "claude-1.jsonl");
        Directory.CreateDirectory(Path.GetDirectoryName(projectPath)!);
        File.WriteAllText(
            projectPath,
            string.Join(
                Environment.NewLine,
                """
                {"sessionId":"session-claude-1","cwd":"__CWD__","type":"meta"}
                {"sessionId":"session-claude-1","cwd":"__CWD__","type":"user","message":{"role":"user","content":[{"type":"text","text":"Pick up the MidTerm App Server Controller resume session"}]}}
                """.Replace("__CWD__", EscapeJson(workingDirectory), StringComparison.Ordinal)),
            Encoding.UTF8);
        File.SetLastWriteTimeUtc(projectPath, new DateTime(2026, 4, 6, 13, 15, 0, DateTimeKind.Utc));

        var service = new ProviderResumeCatalogService(_root);

        var candidates = service.GetCandidates("claude", workingDirectory, includeAllDirectories: false);

        var candidate = Assert.Single(candidates);
        Assert.Equal("claude", candidate.Provider);
        Assert.Equal("session-claude-1", candidate.SessionId);
        Assert.Equal(workingDirectory, candidate.WorkingDirectory);
        Assert.True(candidate.Title.Contains("Pick up the MidTerm App Server Controller resume session", StringComparison.Ordinal));
    }

    [Fact]
    public void GetCandidates_CurrentFolderScopeFiltersOutOtherDirectories()
    {
        var currentWorkingDirectory = Path.Combine(_root, "repos", "MidTermWorkspace3");
        var otherWorkingDirectory = Path.Combine(_root, "repos", "OtherRepo");
        Directory.CreateDirectory(currentWorkingDirectory);
        Directory.CreateDirectory(otherWorkingDirectory);

        var codexDir = Path.Combine(_root, ".codex", "sessions", "2026", "04", "06");
        Directory.CreateDirectory(codexDir);
        File.WriteAllText(
            Path.Combine(codexDir, "current.jsonl"),
            string.Join(
                Environment.NewLine,
                """
                {"type":"session_meta","payload":{"id":"thread-current","cwd":"__CWD__","timestamp":"2026-04-06T12:00:00Z"}}
                {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Current repo thread"}]}}
                """.Replace("__CWD__", EscapeJson(currentWorkingDirectory), StringComparison.Ordinal)),
            Encoding.UTF8);
        File.WriteAllText(
            Path.Combine(codexDir, "other.jsonl"),
            string.Join(
                Environment.NewLine,
                """
                {"type":"session_meta","payload":{"id":"thread-other","cwd":"__CWD__","timestamp":"2026-04-06T11:00:00Z"}}
                {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Other repo thread"}]}}
                """.Replace("__CWD__", EscapeJson(otherWorkingDirectory), StringComparison.Ordinal)),
            Encoding.UTF8);
        File.SetLastWriteTimeUtc(Path.Combine(codexDir, "current.jsonl"), new DateTime(2026, 4, 6, 12, 5, 0, DateTimeKind.Utc));
        File.SetLastWriteTimeUtc(Path.Combine(codexDir, "other.jsonl"), new DateTime(2026, 4, 6, 11, 5, 0, DateTimeKind.Utc));

        var service = new ProviderResumeCatalogService(_root);

        var currentOnly = service.GetCandidates("codex", currentWorkingDirectory, includeAllDirectories: false);
        var all = service.GetCandidates("codex", currentWorkingDirectory, includeAllDirectories: true);

        Assert.Single(currentOnly);
        Assert.Equal("thread-current", currentOnly[0].SessionId);
        Assert.Equal(2, all.Count);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
        catch
        {
        }
    }

    private static string EscapeJson(string value)
    {
        return value.Replace("\\", "\\\\", StringComparison.Ordinal);
    }
}
