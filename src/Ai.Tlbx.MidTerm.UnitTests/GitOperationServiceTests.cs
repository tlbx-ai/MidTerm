using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitOperationServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tlbx_git_ops_" + Guid.NewGuid().ToString("N"));
    private readonly GitOperationService _operations = new();

    public GitOperationServiceTests() => Directory.CreateDirectory(_root);
    public void Dispose()
    {
        if (!Path.GetFullPath(_root).StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(_root).StartsWith("tlbx_git_ops_", StringComparison.Ordinal)) throw new InvalidOperationException("Unexpected fixture.");
        if (OperatingSystem.IsWindows()) foreach (var path in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)) File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);
        Directory.Delete(_root, recursive: true); GC.SuppressFinalize(this);
    }

    private async Task Git(params string[] args)
    { var result = await GitCommandRunner.ExecuteAsync(_root, args, default); Assert.True(result.ExitCode == 0, result.Stderr); }
    private void Write(string name, string text) => File.WriteAllText(Path.Combine(_root, name), text);
    private string Read(string name) => File.ReadAllText(Path.Combine(_root, name));
    private async Task Init(bool commit = true)
    {
        await Git("init", "--quiet"); await Git("config", "user.name", "Git operations acceptance"); await Git("config", "user.email", "ops@tlbx.invalid"); await Git("config", "commit.gpgSign", "false");
        Write("a.txt", "A baseline\n"); Write("b.txt", "B baseline\n");
        if (commit) { await Git("add", "."); await Git("commit", "--quiet", "-m", "Baseline"); }
    }
    private static GitOperationRequest Request(string action, params string[] paths) => new() { Action = action, Paths = paths, OperationId = Guid.NewGuid().ToString("D") };
    private async Task<GitOperationResponse> Execute(GitOperationRequest request) => await _operations.ExecuteAsync(_root, request, default);
    private async Task<GitOperationRequest> Commit(string message)
    {
        var state = await GitCommandRunner.GetStatusAsync(_root);
        return new() { Action = "commit", OperationId = Guid.NewGuid().ToString("D"), Message = message, ExpectedIndexVersion = state.IndexVersion, ExpectedHead = state.HeadHash };
    }

    [Fact]
    public async Task StageAndUnstagePreserveWorkingTreeAndDistinguishIndexContent()
    {
        await Init(); Write("a.txt", "A staged\n");
        var staged = await Execute(Request("stage", "a.txt")); Assert.Equal("completed", staged.State); Assert.Equal("a.txt", Assert.Single(staged.Status!.Staged).Path);
        Write("a.txt", "A staged\nLater working change\n");
        var both = await GitCommandRunner.GetStatusAsync(_root); Assert.Single(both.Staged); Assert.Single(both.Modified);
        var removed = await Execute(Request("unstage", "a.txt")); Assert.Empty(removed.Status!.Staged); Assert.Equal("A staged\nLater working change\n", Read("a.txt"));
    }

    [Fact]
    public async Task UnbornIndexUnstagesWithoutDeletingAnyFiles()
    {
        await Init(commit: false); var stage = Request("stage"); stage.All = true; Assert.Equal("completed", (await Execute(stage)).State);
        var unstage = Request("unstage"); unstage.All = true; var result = await Execute(unstage); Assert.Equal("completed", result.State); Assert.Empty(result.Status!.Staged); Assert.Equal(2, result.Status.Untracked.Length); Assert.Equal("A baseline\n", Read("a.txt"));
    }

    [Fact]
    public async Task LiteralPathsDoNotExpandWildcardsOrOptions()
    {
        await Init(); const string special = "spaces ä $` [one].txt"; Write(special, "Exact\n"); Write("one.txt", "Other\n"); Write("--option.txt", "Option-like\n");
        var result = await Execute(Request("stage", special, "--option.txt")); Assert.Equal("completed", result.State); Assert.Equal(2, result.Status!.Staged.Length); Assert.Contains(result.Status.Staged, file => file.Path == special); Assert.Contains(result.Status.Untracked, file => file.Path == "one.txt");
    }

    [Fact]
    public async Task CommitUsesOnlyReviewedIndexAndReplaysItsReceiptWithoutDuplicateCommits()
    {
        await Init(); Write("a.txt", "A selected\n"); Write("b.txt", "B unstaged\n"); await Execute(Request("stage", "a.txt"));
        var request = await Commit("Subject ä\n\n# literal body\nSecond paragraph"); var committed = await Execute(request); Assert.Equal("completed", committed.State); Assert.False(string.IsNullOrEmpty(committed.CommitHash));
        var a = await GitCommandRunner.ExecuteAsync(_root, ["show", "HEAD:a.txt"], default); var b = await GitCommandRunner.ExecuteAsync(_root, ["show", "HEAD:b.txt"], default);
        Assert.Equal("A selected\n", a.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal)); Assert.Equal("B baseline\n", b.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal)); Assert.Equal("B unstaged\n", Read("b.txt"));
        var repeated = await new GitOperationService().ExecuteAsync(_root, request, default); Assert.Equal(committed.CommitHash, repeated.CommitHash);
        var count = await GitCommandRunner.ExecuteAsync(_root, ["rev-list", "--count", "HEAD"], default); Assert.Equal("2", count.Stdout.Trim());
        var message = await GitCommandRunner.ExecuteAsync(_root, ["log", "-1", "--format=%B"], default); Assert.Contains("# literal body", message.Stdout, StringComparison.Ordinal); Assert.Contains("Subject ä", message.Stdout, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ChangedIndexRejectsTheCommitAndRetainsStagedAndWorkingContent()
    {
        await Init(); Write("a.txt", "A selected\n"); await Execute(Request("stage", "a.txt")); var request = await Commit("Reviewed commit");
        Write("b.txt", "External staged\n"); await Git("add", "b.txt"); var result = await Execute(request); Assert.Equal("index_changed", result.ErrorCode); Assert.Equal(409, result.StatusCode); Assert.Equal(2, result.Status!.Staged.Length);
        Assert.Equal("A selected\n", Read("a.txt")); var count = await GitCommandRunner.ExecuteAsync(_root, ["rev-list", "--count", "HEAD"], default); Assert.Equal("1", count.Stdout.Trim());
    }

    [Fact]
    public async Task MissingIdentityAndFailingHookRetainIndexAndDoNotCreateCommits()
    {
        await Init(); Write("a.txt", "Staged content\n"); await Execute(Request("stage", "a.txt"));
        await Git("config", "user.name", ""); await Git("config", "user.email", ""); var identity = await Execute(await Commit("Needs identity")); Assert.Equal("identity_missing", identity.ErrorCode); Assert.Single(identity.Status!.Staged);
        await Git("config", "user.name", "Acceptance"); await Git("config", "user.email", "ops@tlbx.invalid");
        var hooks = Path.Combine(_root, ".git", "acceptance-hooks"); Directory.CreateDirectory(hooks); var hook = Path.Combine(hooks, "pre-commit"); await File.WriteAllTextAsync(hook, "#!/bin/sh\necho 'Acceptance hook rejected commit' >&2\nexit 1\n"); if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(hook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        await Git("config", "core.hooksPath", hooks); var failed = await Execute(await Commit("Hook rejection")); Assert.Equal("git_failed", failed.ErrorCode); Assert.Contains("Acceptance hook rejected", failed.Detail, StringComparison.Ordinal); Assert.Single(failed.Status!.Staged); Assert.False(File.Exists(Path.Combine(_root, ".git", "index.lock")));
    }

    [Fact]
    public async Task RenameUnstageRestoresBothIndexPathsWithoutChangingDisk()
    {
        await Init(); await Git("mv", "a.txt", "renamed ä.txt"); var result = await Execute(Request("unstage", "renamed ä.txt")); Assert.Equal("completed", result.State); Assert.Empty(result.Status!.Staged); Assert.False(File.Exists(Path.Combine(_root, "a.txt"))); Assert.Equal("A baseline\n", Read("renamed ä.txt"));
    }

    [Fact]
    public async Task ExternalIndexLockAndInvalidPathsCannotMutateRepository()
    {
        await Init(); Write("a.txt", "Changed\n"); var index = Path.Combine(_root, ".git", "index"); var before = await GitCommandRunner.HashIndexAsync(index); await File.WriteAllTextAsync(index + ".lock", "External lock");
        var locked = await Execute(Request("stage", "a.txt")); Assert.Equal("git_locked", locked.ErrorCode); Assert.Equal("External lock", await File.ReadAllTextAsync(index + ".lock")); File.Delete(index + ".lock");
        var denied = await Execute(Request("stage", "../outside.txt")); Assert.Equal("path_outside_repository", denied.ErrorCode); Assert.Equal(before, await GitCommandRunner.HashIndexAsync(index));
    }

    private async Task SlowHook(int seconds)
    {
        var hooks = Path.Combine(_root, ".git", "acceptance-hooks"); Directory.CreateDirectory(hooks);
        var hook = Path.Combine(hooks, "pre-commit");
        await File.WriteAllTextAsync(hook, $"#!/bin/sh\nprintf 'ready' > hook-ready.marker\nsleep {seconds.ToString(System.Globalization.CultureInfo.InvariantCulture)}\nexit 0\n");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(hook, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        await Git("config", "core.hooksPath", hooks);
    }

    [Fact]
    public async Task NativeIndexLockBlocksExternalStagingAndConcurrentReplayCreatesExactlyOneCommit()
    {
        await Init(); Write("a.txt", "Reviewed change\n"); Write("b.txt", "External change\n"); await Execute(Request("stage", "a.txt")); await SlowHook(2);
        var request = await Commit("One reviewed commit"); var pending = Execute(request);
        for (var i = 0; i < 100 && !File.Exists(Path.Combine(_root, "hook-ready.marker")); i++) await Task.Delay(25, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(_root, "hook-ready.marker")));
        var external = await GitCommandRunner.ExecuteAsync(_root, ["add", "b.txt"], default);
        Assert.NotEqual(0, external.ExitCode); Assert.Contains("index.lock", external.Stderr, StringComparison.Ordinal);
        var duplicate = Execute(request); var first = await pending; var second = await duplicate;
        Assert.Equal("completed", first.State); Assert.Equal(first.CommitHash, second.CommitHash);
        var b = await GitCommandRunner.ExecuteAsync(_root, ["show", "HEAD:b.txt"], default); Assert.Equal("B baseline\n", b.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal)); Assert.Equal("External change\n", Read("b.txt"));
        Assert.False(File.Exists(Path.Combine(_root, ".git", "index.lock")));
    }

    [Fact]
    public async Task CancellationKillsOwnedHookTreeAndPreservesHeadIndexAndDisk()
    {
        await Init(); Write("a.txt", "Reviewed change\n"); await Execute(Request("stage", "a.txt")); await SlowHook(5);
        var before = await GitCommandRunner.GetStatusAsync(_root); var request = await Commit("Cancelled commit");
        using var cancellation = new CancellationTokenSource(); var pending = _operations.ExecuteAsync(_root, request, cancellation.Token);
        for (var i = 0; i < 100 && !File.Exists(Path.Combine(_root, "hook-ready.marker")); i++) await Task.Delay(25, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(_root, "hook-ready.marker"))); cancellation.Cancel();
        var result = await pending; Assert.Equal("error", result.State); Assert.Equal("git_timeout", result.ErrorCode);
        var after = await GitCommandRunner.GetStatusAsync(_root); Assert.Equal(before.HeadHash, after.HeadHash); Assert.Equal(before.IndexVersion, after.IndexVersion); Assert.Equal("Reviewed change\n", Read("a.txt"));
        Assert.False(File.Exists(Path.Combine(_root, ".git", "index.lock")));
    }

    [Fact]
    public async Task CreatedCommitWithBlockedIndexPublicationReportsItsHashAndNeverRecommits()
    {
        if (!OperatingSystem.IsWindows()) return;
        await Init(); Write("a.txt", "Reviewed change\n"); await Execute(Request("stage", "a.txt"));
        var hooks = Path.Combine(_root, ".git", "acceptance-hooks"); Directory.CreateDirectory(hooks);
        await File.WriteAllTextAsync(Path.Combine(hooks, "post-commit"), "#!/bin/sh\nprintf 'ready' > publication-ready.marker\nsleep 1\n");
        await Git("config", "core.hooksPath", hooks);
        var request = await Commit("Confirmed commit despite index publication error"); var pending = Execute(request);
        for (var i = 0; i < 100 && !File.Exists(Path.Combine(_root, "publication-ready.marker")); i++) await Task.Delay(25, CancellationToken.None);
        Assert.True(File.Exists(Path.Combine(_root, "publication-ready.marker")));
        using var heldIndex = new FileStream(Path.Combine(_root, ".git", "index"), FileMode.Open, FileAccess.Read, FileShare.Read);
        var result = await pending;
        Assert.Equal("unknown", result.State); Assert.Equal("index_publication_failed", result.ErrorCode);
        var head = await GitCommandRunner.ExecuteAsync(_root, ["rev-parse", "HEAD"], default);
        Assert.Equal(head.Stdout.Trim(), result.CommitHash);
        Assert.True(File.Exists(Path.Combine(_root, ".git", "index.tlbx-" + request.OperationId)));
        var replay = await Execute(request); Assert.Equal(result.CommitHash, replay.CommitHash); Assert.Equal("unknown", replay.State);
        var count = await GitCommandRunner.ExecuteAsync(_root, ["rev-list", "--count", "HEAD"], default); Assert.Equal("2", count.Stdout.Trim());
    }
}
