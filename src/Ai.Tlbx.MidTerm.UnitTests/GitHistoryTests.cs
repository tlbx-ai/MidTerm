using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitHistoryTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tlbx_git_history_" + Guid.NewGuid().ToString("N"));
    public GitHistoryTests() => Directory.CreateDirectory(_root);
    public void Dispose()
    {
        if (!Path.GetFileName(_root).StartsWith("tlbx_git_history_", StringComparison.Ordinal)) throw new InvalidOperationException();
        if (OperatingSystem.IsWindows()) foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)) File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
        Directory.Delete(_root, true); GC.SuppressFinalize(this);
    }
    private async Task<string> Git(params string[] args)
    { var result = await GitCommandRunner.ExecuteAsync(_root, args, default); Assert.True(result.ExitCode == 0, result.Stderr); return result.Stdout.TrimEnd('\r', '\n'); }
    private async Task Init()
    { await Git("init", "-q"); await Git("config", "user.name", "Author ä 字"); await Git("config", "user.email", "history@tlbx.invalid"); await Git("config", "commit.gpgSign", "false"); }

    [Fact]
    public async Task PagesKeepEmptySubjectsUnicodeAndSnapshotOrderAcrossNewCommits()
    {
        await Init();
        for (var index = 0; index < 53; index++) await Git("commit", "--allow-empty", "--allow-empty-message", "-qm", index == 17 ? "" : "Commit ä 字 " + index.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var head = await Git("rev-parse", "HEAD"); var expected = (await Git("rev-list", "HEAD")).Split('\n').Select(hash => hash.TrimEnd('\r')).ToArray();
        var page1 = await GitCommandRunner.GetLogAsync(_root, 20, 0, head);
        await Git("commit", "--allow-empty", "-qm", "New live head");
        var page2 = await GitCommandRunner.GetLogAsync(_root, 20, 20, head); var page3 = await GitCommandRunner.GetLogAsync(_root, 20, 40, head);
        var entries = page1.Concat(page2).Concat(page3).ToArray(); Assert.Equal(expected, entries.Select(entry => entry.Hash), StringComparer.Ordinal); Assert.Equal(53, entries.Length);
        Assert.Single(entries, entry => entry.Message.Length == 0); Assert.All(entries, entry => Assert.Equal("Author ä 字", entry.Author));
        Assert.Empty(await GitCommandRunner.GetLogAsync(_root, 20, 53, head)); Assert.NotEqual(head, await Git("rev-parse", "HEAD"), StringComparer.Ordinal);
    }

    [Fact]
    public async Task InvalidPagesAndSnapshotOptionsAreRejectedWithoutChangingHead()
    {
        await Init(); await Git("commit", "--allow-empty", "-qm", "base"); var head = await Git("rev-parse", "HEAD");
        await Assert.ThrowsAsync<IOException>(() => GitCommandRunner.GetLogAsync(_root, 0));
        await Assert.ThrowsAsync<IOException>(() => GitCommandRunner.GetLogAsync(_root, 20, -1));
        await Assert.ThrowsAsync<IOException>(() => GitCommandRunner.GetLogAsync(_root, 20, 0, "--all"));
        Assert.Equal(head, await Git("rev-parse", "HEAD"));
    }

    [Fact]
    public async Task MissingSnapshotObjectIsAnErrorRatherThanAnEmptySuccessfulPage()
    {
        await Init(); await Git("commit", "--allow-empty", "-qm", "base"); var head = await Git("rev-parse", "HEAD");
        var objectPath = Path.Combine(_root, ".git", "objects", head[..2], head[2..]); File.SetAttributes(objectPath, FileAttributes.Normal); File.Delete(objectPath);
        await Assert.ThrowsAsync<IOException>(() => GitCommandRunner.GetLogAsync(_root, 20, 0, head));
    }
}
