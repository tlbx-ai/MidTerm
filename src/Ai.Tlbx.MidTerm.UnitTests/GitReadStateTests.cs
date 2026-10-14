using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitReadStateTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tlbx_git_read_state_" + Guid.NewGuid().ToString("N"));
    public GitReadStateTests() => Directory.CreateDirectory(_root);
    public void Dispose()
    {
        if (!Path.GetFileName(_root).StartsWith("tlbx_git_read_state_", StringComparison.Ordinal)) throw new InvalidOperationException();
        if (OperatingSystem.IsWindows()) foreach (var path in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)) File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);
        Directory.Delete(_root, recursive: true); GC.SuppressFinalize(this);
    }
    private async Task<string> Git(params string[] args)
    { var result = await GitCommandRunner.ExecuteAsync(_root, args, default); Assert.True(result.ExitCode == 0, result.Stderr); return result.Stdout.TrimEnd('\r', '\n'); }
    private async Task<GitOperationRequest> PrepareCommit()
    {
        await Git("init", "--quiet"); await Git("config", "user.name", "Read state acceptance"); await Git("config", "user.email", "state@tlbx.invalid"); await Git("config", "commit.gpgSign", "false"); await Git("config", "core.autocrlf", "false");
        await File.WriteAllTextAsync(Path.Combine(_root, "file.txt"), "Baseline\n", Xunit.TestContext.Current.CancellationToken); await Git("add", "."); await Git("commit", "--quiet", "-m", "Baseline");
        await File.WriteAllTextAsync(Path.Combine(_root, "file.txt"), "Reviewed content ä\n", Xunit.TestContext.Current.CancellationToken); await Git("add", ".");
        var status = await GitCommandRunner.GetStatusAsync(_root);
        return new() { Action = "commit", OperationId = Guid.NewGuid().ToString("D"), Message = "Confirmed independently", ExpectedIndexVersion = status.IndexVersion, ExpectedHead = status.HeadHash };
    }
    private async Task Hook(string text)
    {
        var path = Path.Combine(_root, ".git", "hooks", "post-commit"); await File.WriteAllTextAsync(path, "#!/bin/sh\n" + text + "\n", Xunit.TestContext.Current.CancellationToken);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    [Fact]
    public async Task MissingRepositoryAndFailedWorkingTreeReadHaveDistinctHonestStates()
    {
        var missing = await GitCommandRunner.GetStatusAsync(_root); Assert.Equal("no-repo", missing.ReadState); Assert.Equal("no_repository", missing.ErrorCode);
        await PrepareCommit(); var good = await GitCommandRunner.GetStatusAsync(_root); Assert.Equal("ready", good.ReadState); Assert.NotNull(good.ReadAt);
        await Git("config", "core.worktree", Path.Combine(_root, "missing-working-tree"));
        var failed = await GitCommandRunner.GetStatusAsync(_root); Assert.Equal("error", failed.ReadState); Assert.Equal("git_read_failed", failed.ErrorCode);
        var stale = good.WithReadFailure(failed); Assert.Equal("stale", stale.ReadState); Assert.Equal(good.HeadHash, stale.HeadHash); Assert.Equal(good.IndexVersion, stale.IndexVersion);
        Assert.Equal(good.Staged, stale.Staged); Assert.Equal("ready", good.ReadState); Assert.Null(good.ErrorCode);
    }

    [Fact]
    public async Task ActualCommitIsConfirmedEvenWhenItsPostCommitHookBreaksStatusReading()
    {
        var request = await PrepareCommit(); await Hook("git config status.renames invalid");
        var result = await new GitOperationService().ExecuteAsync(_root, request, default);
        Assert.Equal("completed", result.State); Assert.NotNull(result.CommitHash); Assert.NotEqual("", result.CommitHash, StringComparer.Ordinal); Assert.NotEqual(request.ExpectedHead, result.CommitHash, StringComparer.Ordinal);
        Assert.Equal(result.CommitHash, await GitCommandRunner.GetCommittedHeadAsync(_root), StringComparer.Ordinal); Assert.NotEqual("ready", result.Status!.ReadState, StringComparer.Ordinal);
        await Git("config", "--unset", "status.renames"); Assert.Equal("Reviewed content ä", (await Git("show", "HEAD:file.txt")).TrimEnd());
        Assert.Empty((await GitCommandRunner.GetStatusAsync(_root)).Staged);
    }

    [Fact]
    public async Task UnreadableHeadAfterSuccessfulGitCommitRetainsAnUnknownReceiptWithoutAnEmptyConfirmedHash()
    {
        var request = await PrepareCommit(); await Hook("mv .git/HEAD .git/HEAD.held");
        var operations = new GitOperationService(); var result = await operations.ExecuteAsync(_root, request, default);
        Assert.Equal("unknown", result.State); Assert.Equal("commit_unconfirmed", result.ErrorCode); Assert.Null(result.CommitHash);
        Assert.True(File.Exists(Path.Combine(_root, ".git", "index.tlbx-" + request.OperationId)));
        File.Move(Path.Combine(_root, ".git", "HEAD.held"), Path.Combine(_root, ".git", "HEAD"));
        var actualHead = await GitCommandRunner.GetCommittedHeadAsync(_root); Assert.NotNull(actualHead); Assert.NotEqual(request.ExpectedHead, actualHead, StringComparer.Ordinal);
        var replay = await operations.ExecuteAsync(_root, request, default); Assert.Equal("unknown", replay.State); Assert.Null(replay.CommitHash);
        Assert.Equal(actualHead, await GitCommandRunner.GetCommittedHeadAsync(_root));
    }
}
