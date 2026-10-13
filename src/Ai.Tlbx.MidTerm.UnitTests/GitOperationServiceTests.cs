using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
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
    public async Task NewFileStatisticsKeepIndexAndWorkingTreeChangesSeparate()
    {
        await Init(); await Git("config", "core.autocrlf", "false");
        Write("new ä.txt", "Reviewed 字\n"); await Execute(Request("stage", "new ä.txt"));
        Write("new ä.txt", "Reviewed 字\nLater working ä\n");
        var status = await GitCommandRunner.GetStatusAsync(_root);
        Assert.Equal("added", Assert.Single(status.Staged).Status);
        Assert.Equal("modified", Assert.Single(status.Modified).Status);
        var staged = await GitCommandRunner.GetNumStatAsync(_root, staged: true);
        var working = await GitCommandRunner.GetNumStatAsync(_root, staged: false);
        Assert.Equal((1, 0), staged["new ä.txt"]); Assert.Equal((1, 0), working["new ä.txt"]);
        await Execute(Request("stage", "new ä.txt"));
        Assert.Empty((await GitCommandRunner.GetStatusAsync(_root)).Modified);
        Assert.Equal((2, 0), (await GitCommandRunner.GetNumStatAsync(_root, staged: true))["new ä.txt"]);
        await Execute(Request("unstage", "new ä.txt"));
        Assert.Equal("untracked", Assert.Single((await GitCommandRunner.GetStatusAsync(_root)).Untracked).Status);
        Assert.Equal("Reviewed 字\nLater working ä\n", Read("new ä.txt"));
    }

    [Fact]
    public async Task LongUnicodeCommitBodyIsPreservedBeyondWindowsCommandLineLength()
    {
        await Init(); Write("a.txt", "Long body committed bytes\n"); await Execute(Request("stage", "a.txt"));
        var message = "Long Unicode body\n\n# Verbatim comment\n" + string.Concat(Enumerable.Repeat("ä字😀 body\n", 5000));
        var request = await Commit(message); var result = await Execute(request);
        Assert.Equal("completed", result.State);
        var stored = await GitCommandRunner.ExecuteAsync(_root, ["log", "-1", "--format=%B"], default);
        Assert.Equal(0, stored.ExitCode); Assert.Equal(message.TrimEnd('\n'), stored.Stdout.TrimEnd('\r', '\n'));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_root, ".git"), "*.message"));
    }

    [Fact]
    public async Task RepositoryLabelsRemainIndependentAcrossSessionsSharingOneCache()
    {
        await Init(); using var watcher = new GitWatcherService(); watcher.ConfigureSessionValidator(static _ => true);
        await watcher.AddSessionRepoAsync("alpha", _root, "Target A", "target", "manual");
        await watcher.AddSessionRepoAsync("beta", _root, "Supervisor B", "supervisor", "manual");
        var alpha = Assert.Single(watcher.GetRepoBindings("alpha")).Status!;
        var beta = Assert.Single(watcher.GetRepoBindings("beta")).Status!;
        Assert.Equal("Target A", alpha.Label); Assert.Equal("target", alpha.Role);
        Assert.Equal("Supervisor B", beta.Label); Assert.Equal("supervisor", beta.Role); Assert.NotSame(alpha, beta);
        Assert.Equal("Target A", watcher.GetCachedStatus("alpha", _root)!.Label);
        Assert.Equal("Supervisor B", watcher.GetCachedStatus("beta", _root)!.Label);
        Assert.Equal("Target A", Assert.Single(watcher.GetRepoBindings("alpha")).Status!.Label);
        watcher.UnregisterSession("alpha"); watcher.UnregisterSession("beta");
        await watcher.WaitForSessionCleanupAsync("alpha"); await watcher.WaitForSessionCleanupAsync("beta");
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

    [UnixFact]
    public async Task LogicalRepositoryAliasSharesThePhysicalIndexAndReceipt()
    {
        await Init(); Write("a.txt", "Alias reviewed content\n");
        var alias = Path.Combine(_root, "logical-alias"); Directory.CreateSymbolicLink(alias, _root);
        var request = Request("stage", "a.txt");
        var staged = await _operations.ExecuteAsync(alias, request, default);
        Assert.Equal("completed", staged.State);
        Assert.Equal(FileDocumentService.ResolvePath(_root), staged.RepoRoot);
        var replay = await Execute(request); Assert.Equal("completed", replay.State);
        Assert.Single(replay.Status!.Staged); Assert.Equal("a.txt", replay.Status.Staged[0].Path);
        var removed = await _operations.ExecuteAsync(alias, Request("unstage", "a.txt"), default);
        Assert.Equal("completed", removed.State); Assert.Empty(removed.Status!.Staged);
        Assert.Equal("Alias reviewed content\n", Read("a.txt"));
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
    public async Task FileDiffReadsOnlyTheLiteralSelectedPath()
    {
        await Init(); Write("literal[abc].txt", "Literal baseline\n"); Write("literala.txt", "Other baseline\n");
        await Git("add", "."); await Git("commit", "--quiet", "-m", "Literal names baseline");
        Write("literal[abc].txt", "Literal reviewed content\n"); Write("literala.txt", "Unrelated content\n");
        var diff = await GitCommandRunner.GetDiffPatchAsync(_root, "literal[abc].txt", staged: false);
        Assert.Contains("+Literal reviewed content", diff.Patch, StringComparison.Ordinal);
        Assert.DoesNotContain("+Unrelated content", diff.Patch, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NativeQuotedNamesRoundTripThroughPatchAndNullSeparatedStatistics()
    {
        await Init();
        var names = new List<string> { "Unicode ä字.txt", "smart‘quote’.txt", "space name.txt", "it's quoted.txt" };
        if (!OperatingSystem.IsWindows()) names.AddRange(["double\"quote.txt", "literal\\backslash.txt", "tab\tname.txt", "line\nname.txt", "trailing .txt "]);
        foreach (var name in names) Write(name, "Baseline\n");
        await Git("add", "."); await Git("commit", "--quiet", "-m", "Quoted paths baseline");
        foreach (var name in names) Write(name, "Exact reviewed content\n");
        var statistics = await GitCommandRunner.GetNumStatAsync(_root, staged: false);
        foreach (var name in names)
        {
            Assert.Equal((1, 1), statistics[name]);
            var patch = await GitCommandRunner.GetDiffPatchAsync(_root, name, staged: false);
            var file = Assert.Single(GitPatchParser.ParseDiff("worktree", patch.Patch, patch.IsTruncated).Files);
            Assert.Equal(name, file.Path); Assert.Null(file.OriginalPath);
            Assert.Equal(1, file.Additions); Assert.Equal(1, file.Deletions);
            Assert.Contains(file.Hunks.SelectMany(hunk => hunk.Lines), line => line.Text == "+Exact reviewed content");
        }
    }

    [Fact]
    public async Task NativeRenameMetadataPreservesRealLeadingADirectoryAndBDestination()
    {
        await Init(); Directory.CreateDirectory(Path.Combine(_root, "a")); Directory.CreateDirectory(Path.Combine(_root, "b"));
        const string source = "a/source ä.txt"; const string destination = "b/destination ä.txt";
        Write(source, "Rename content\n"); await Git("add", "."); await Git("commit", "--quiet", "-m", "Rename baseline");
        await Git("mv", source, destination);
        var patch = await GitCommandRunner.ExecuteAsync(_root, ["diff", "--cached", "--find-renames"], default);
        var file = Assert.Single(GitPatchParser.ParseDiff("staged", patch.Stdout, false).Files);
        Assert.Equal(destination, file.Path); Assert.Equal(source, file.OriginalPath); Assert.Equal("renamed", file.Status);
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

    [WindowsFact]
    public async Task CreatedCommitWithBlockedIndexPublicationReportsItsHashAndNeverRecommits()
    {
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

    [Fact]
    public async Task InheritedRepositoryEnvironmentCannotRedirectStatusStagingOrCommits()
    {
        await Init(); Write("a.txt", "Selected change\n");
        var other = Path.Combine(_root, "other"); Directory.CreateDirectory(other);
        var init = await GitCommandRunner.ExecuteAsync(other, ["init", "--quiet"], default); Assert.Equal(0, init.ExitCode);
        await File.WriteAllTextAsync(Path.Combine(other, "a.txt"), "Other change\n");
        var otherIndex = Path.Combine(other, ".git", "index");
        var overrides = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["GIT_DIR"] = Path.Combine(other, ".git"), ["GIT_WORK_TREE"] = other,
            ["GIT_INDEX_FILE"] = otherIndex, ["GIT_COMMON_DIR"] = Path.Combine(other, ".git"),
            ["GIT_NAMESPACE"] = "unexpected", ["GIT_CONFIG_COUNT"] = "1",
            ["GIT_CONFIG_KEY_0"] = "core.worktree", ["GIT_CONFIG_VALUE_0"] = other
        };
        var saved = overrides.Keys.ToDictionary(key => key, Environment.GetEnvironmentVariable, StringComparer.Ordinal);
        try
        {
            foreach (var pair in overrides) Environment.SetEnvironmentVariable(pair.Key, pair.Value);
            var state = await GitCommandRunner.GetStatusAsync(_root); Assert.Equal(_root, state.RepoRoot);
            var staged = await Execute(Request("stage", "a.txt")); Assert.Equal("completed", staged.State);
            var committed = await Execute(await Commit("Correct selected repository")); Assert.Equal("completed", committed.State);
            var content = await GitCommandRunner.ExecuteAsync(_root, ["show", "HEAD:a.txt"], default); Assert.Equal("Selected change\n", content.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal));
            Assert.False(File.Exists(otherIndex)); Assert.Equal("Other change\n", await File.ReadAllTextAsync(Path.Combine(other, "a.txt")));
        }
        finally { foreach (var pair in saved) Environment.SetEnvironmentVariable(pair.Key, pair.Value); }
    }

    [Fact]
    public async Task RemovedBindingRejectsQueuedMutationBeforeCreatingReceiptOrChangingIndex()
    {
        await Init(); Write("a.txt", "Untouched change\n"); var before = await GitCommandRunner.GetStatusAsync(_root);
        var request = Request("stage", "a.txt");
        var error = await Assert.ThrowsAsync<GitOperationException>(() => _operations.ExecuteAsync(_root, request, default, () => false));
        Assert.Equal("repository_unbound", error.Code);
        Assert.Equal(before.IndexVersion, (await GitCommandRunner.GetStatusAsync(_root)).IndexVersion);
        Assert.False(Directory.Exists(Path.Combine(_root, ".git", "tlbx-operation-receipts")));
    }
}
