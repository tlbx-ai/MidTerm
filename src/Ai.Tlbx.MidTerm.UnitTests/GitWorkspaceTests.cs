using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitWorkspaceTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "tlbx_git_workspace_" + Guid.NewGuid().ToString("N"));
    private string Root => Path.Combine(_folder, "work");
    private readonly GitOperationService _operations = new();
    public GitWorkspaceTests() => Directory.CreateDirectory(Root);
    public void Dispose()
    {
        if (!Path.GetFileName(_folder).StartsWith("tlbx_git_workspace_", StringComparison.Ordinal)) throw new InvalidOperationException();
        if (OperatingSystem.IsWindows()) foreach (var file in Directory.EnumerateFiles(_folder, "*", SearchOption.AllDirectories)) File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
        Directory.Delete(_folder, true); GC.SuppressFinalize(this);
    }
    private static async Task<string> Git(string root, params string[] args)
    { var result = await GitCommandRunner.ExecuteAsync(root, args, default); Assert.True(result.ExitCode == 0, result.Stderr); return result.Stdout.TrimEnd('\r', '\n'); }
    private async Task Init()
    {
        await Git(Root, "init", "-q", "-b", "main"); await Identity(Root);
        await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "base\n"); await Git(Root, "add", "."); await Git(Root, "commit", "-qm", "base");
    }
    private static async Task Identity(string root)
    { await Git(root, "config", "user.name", "Workspace acceptance"); await Git(root, "config", "user.email", "workspace@tlbx.invalid"); await Git(root, "config", "commit.gpgSign", "false"); await Git(root, "config", "core.autocrlf", "false"); }
    private async Task<GitOperationRequest> Request(string action)
    { var current = await GitWorkspaceQuery.ReadAsync(Root, default); return new() { OperationId = Guid.NewGuid().ToString("D"), Action = action, ExpectedHead = current.HeadHash, ExpectedBranch = current.CurrentBranch, ExpectedIndexVersion = current.IndexVersion }; }
    private Task<GitOperationResponse> Execute(GitOperationRequest request) => _operations.ExecuteAsync(Root, request, default);

    [Fact]
    public async Task BranchesUseLiteralNamesAndDirtySwitchDoesNotOverwriteFiles()
    {
        await Init(); var create = await Request("branch-create"); create.Branch = "feature/ä-space";
        Assert.Equal("completed", (await Execute(create)).State); Assert.Equal("feature/ä-space", (await GitWorkspaceQuery.ReadAsync(Root, default)).CurrentBranch);
        await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "feature\n"); await Git(Root, "commit", "-qam", "feature");
        await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "private dirty\n");
        var change = await Request("branch-switch"); change.Branch = "main"; var rejected = await Execute(change);
        Assert.Equal("error", rejected.State); Assert.Equal("private dirty\n", await File.ReadAllTextAsync(Path.Combine(Root, "file.txt")));
        var invalid = await Request("branch-create"); invalid.Branch = "@{-1}"; Assert.Equal("invalid_branch", (await Execute(invalid)).ErrorCode);
        await Git(Root, "restore", "file.txt"); change = await Request("branch-switch"); change.Branch = "main";
        Assert.Equal("completed", (await Execute(change)).State); Assert.Equal("base\n", await File.ReadAllTextAsync(Path.Combine(Root, "file.txt")));
        var stale = await Execute(create); Assert.Equal("completed", stale.State); Assert.Equal("main", (await GitWorkspaceQuery.ReadAsync(Root, default)).CurrentBranch);
    }

    [Fact]
    public async Task StashPreservesIndexUntrackedFilesAndReplayDoesNotPopAnotherStash()
    {
        await Init(); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "staged\n"); await Git(Root, "add", "file.txt");
        await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "unstaged\n"); await File.WriteAllTextAsync(Path.Combine(Root, "new ä.txt"), "new\n");
        var save = await Request("stash-create"); save.Message = "Mixed ä"; Assert.Equal("completed", (await Execute(save)).State);
        var workspace = await GitWorkspaceQuery.ReadAsync(Root, default); var stash = Assert.Single(workspace.Stashes);
        Assert.Empty((await GitCommandRunner.GetStatusAsync(Root)).Modified); Assert.False(File.Exists(Path.Combine(Root, "new ä.txt")));
        var apply = await Request("stash-apply"); apply.StashHash = stash.Hash; Assert.Equal("completed", (await Execute(apply)).State);
        Assert.Equal("staged", await Git(Root, "show", ":file.txt")); Assert.Equal("unstaged\n", await File.ReadAllTextAsync(Path.Combine(Root, "file.txt")));
        Assert.True(File.Exists(Path.Combine(Root, "new ä.txt"))); Assert.Single((await GitWorkspaceQuery.ReadAsync(Root, default)).Stashes);
        var blocked = await Request("stash-pop"); blocked.StashHash = stash.Hash; Assert.Equal("dirty_working_tree", (await Execute(blocked)).ErrorCode);
        var drop = await Request("stash-drop"); drop.StashHash = stash.Hash; Assert.Equal("completed", (await Execute(drop)).State);
        Assert.Equal("completed", (await Execute(drop)).State); Assert.Empty((await GitWorkspaceQuery.ReadAsync(Root, default)).Stashes);
    }

    private async Task Conflict()
    {
        await Init(); await Git(Root, "switch", "-qc", "incoming"); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "incoming\n"); await Git(Root, "commit", "-qam", "incoming");
        await Git(Root, "switch", "-q", "main"); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "ours\n"); await Git(Root, "commit", "-qam", "ours");
        var merge = await Request("merge"); merge.Branch = "refs/heads/incoming"; Assert.Equal("conflicted", (await Execute(merge)).State);
    }

    [Fact]
    public async Task ReviewedResolutionRejectsStaleBytesAndMergeCommitHasBothParents()
    {
        await Conflict(); var view = await GitWorkspaceQuery.ReadConflictAsync(Root, "file.txt", default); Assert.True(view.HasMarkers); Assert.Equal("ours\n", view.Ours); Assert.Equal("incoming\n", view.Theirs);
        var resolve = await Request("resolve-conflict"); resolve.Paths = ["file.txt"]; resolve.ExpectedFileVersion = view.ContentVersion; resolve.Resolution = "theirs";
        await File.AppendAllTextAsync(Path.Combine(Root, "file.txt"), "changed\n"); Assert.Equal("conflict_changed", (await Execute(resolve)).ErrorCode);
        view = await GitWorkspaceQuery.ReadConflictAsync(Root, "file.txt", default); resolve = await Request("resolve-conflict"); resolve.Paths = ["file.txt"]; resolve.ExpectedFileVersion = view.ContentVersion; resolve.Resolution = "theirs";
        Assert.Equal("completed", (await Execute(resolve)).State); Assert.Equal("incoming\n", await File.ReadAllTextAsync(Path.Combine(Root, "file.txt")));
        var commit = await Request("commit"); commit.Message = "Resolve merge"; Assert.Equal("completed", (await Execute(commit)).State);
        Assert.Equal(3, (await Git(Root, "rev-list", "--parents", "-n", "1", "HEAD")).Split(' ').Length); Assert.False((await GitWorkspaceQuery.ReadAsync(Root, default)).MergeInProgress);
    }

    [Fact]
    public async Task MarkRequiresRemovedMarkersAndAbortRestoresPreMergeState()
    {
        await Conflict(); var view = await GitWorkspaceQuery.ReadConflictAsync(Root, "file.txt", default);
        var mark = await Request("resolve-conflict"); mark.Paths = ["file.txt"]; mark.ExpectedFileVersion = view.ContentVersion; mark.Resolution = "mark";
        Assert.Equal("conflict_markers", (await Execute(mark)).ErrorCode);
        var abort = await Request("merge-abort"); Assert.Equal("completed", (await Execute(abort)).State); Assert.Equal("ours\n", await File.ReadAllTextAsync(Path.Combine(Root, "file.txt"))); Assert.Empty((await GitCommandRunner.GetStatusAsync(Root)).Conflicted);
    }

    [Fact]
    public async Task ExplicitLocalRemoteFetchFastForwardPullPushAndDivergenceAreReal()
    {
        await Init(); var bare = Path.Combine(_folder, "remote.git"); Directory.CreateDirectory(bare); await Git(bare, "init", "--bare", "-q"); await Git(Root, "remote", "add", "origin", bare);
        var push = await Request("push"); push.Remote = "origin"; push.RemoteBranch = "main"; Assert.Equal("completed", (await Execute(push)).State);
        var other = Path.Combine(_folder, "other"); await Git(_folder, "clone", "-q", "-b", "main", bare, other); await Identity(other);
        await File.WriteAllTextAsync(Path.Combine(other, "other.txt"), "other\n"); await Git(other, "add", "."); await Git(other, "commit", "-qm", "other"); await Git(other, "push", "-q", "origin", "main");
        var fetch = await Request("fetch"); fetch.Remote = "origin"; Assert.Equal("completed", (await Execute(fetch)).State);
        var pull = await Request("pull"); pull.Remote = "origin"; pull.RemoteBranch = "main"; Assert.Equal("completed", (await Execute(pull)).State); Assert.True(File.Exists(Path.Combine(Root, "other.txt")));
        await File.WriteAllTextAsync(Path.Combine(Root, "local.txt"), "local\n"); await Git(Root, "add", "."); await Git(Root, "commit", "-qm", "local");
        await File.WriteAllTextAsync(Path.Combine(other, "divergent.txt"), "remote\n"); await Git(other, "add", "."); await Git(other, "commit", "-qm", "divergent"); await Git(other, "push", "-q", "origin", "main");
        var before = await Git(Root, "rev-parse", "HEAD"); pull = await Request("pull"); pull.Remote = "origin"; pull.RemoteBranch = "main"; Assert.Equal("error", (await Execute(pull)).State);
        Assert.Equal(before, await Git(Root, "rev-parse", "HEAD")); push = await Request("push"); push.Remote = "origin"; push.RemoteBranch = "main"; Assert.Equal("error", (await Execute(push)).State);
        Assert.Equal(await Git(other, "rev-parse", "HEAD"), await Git(bare, "rev-parse", "refs/heads/main"));
        var noRemote = await Request("fetch"); Assert.Equal("remote_required", (await Execute(noRemote)).ErrorCode);
    }

    [Fact]
    public async Task SameHeadBranchChangeIsRejectedAndChoosingOursCanFinishAnUnchangedMergeTree()
    {
        await Init(); await Git(Root, "branch", "same"); var stale = await Request("branch-create"); stale.Branch = "new";
        await Git(Root, "switch", "same"); Assert.Equal("workspace_changed", (await Execute(stale)).ErrorCode);
        await Git(Root, "switch", "main");
        await Git(Root, "switch", "-qc", "incoming"); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "incoming\n"); await Git(Root, "commit", "-qam", "incoming");
        await Git(Root, "switch", "main"); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "ours\n"); await Git(Root, "commit", "-qam", "ours");
        var merge = await Request("merge"); merge.Branch = "refs/heads/incoming"; Assert.Equal("conflicted", (await Execute(merge)).State);
        var view = await GitWorkspaceQuery.ReadConflictAsync(Root, "file.txt", default); var resolve = await Request("resolve-conflict"); resolve.Paths = ["file.txt"]; resolve.ExpectedFileVersion = view.ContentVersion; resolve.Resolution = "ours";
        Assert.Equal("completed", (await Execute(resolve)).State); Assert.Empty((await GitCommandRunner.GetStatusAsync(Root)).Staged);
        var commit = await Request("commit"); commit.Message = "Keep ours"; Assert.Equal("completed", (await Execute(commit)).State); Assert.Equal(3, (await Git(Root, "rev-list", "--parents", "-n", "1", "HEAD")).Split(' ').Length);
    }

    [Fact]
    public async Task StashPopConflictKeepsStashAndManualResolutionStagesActualEditedBytes()
    {
        await Init(); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "stash version\n"); Assert.Equal("completed", (await Execute(await Request("stash-create"))).State);
        var stash = Assert.Single((await GitWorkspaceQuery.ReadAsync(Root, default)).Stashes);
        await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "new base\n"); await Git(Root, "commit", "-qam", "new base");
        var pop = await Request("stash-pop"); pop.StashHash = stash.Hash; var result = await Execute(pop); Assert.Equal("conflicted", result.State);
        Assert.Single((await GitWorkspaceQuery.ReadAsync(Root, default)).Stashes); Assert.False((await GitWorkspaceQuery.ReadAsync(Root, default)).MergeInProgress);
        await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "manual merged ä\n"); var view = await GitWorkspaceQuery.ReadConflictAsync(Root, "file.txt", default);
        var mark = await Request("resolve-conflict"); mark.Paths = ["file.txt"]; mark.ExpectedFileVersion = view.ContentVersion; mark.Resolution = "mark"; Assert.Equal("completed", (await Execute(mark)).State);
        Assert.Empty((await GitCommandRunner.GetStatusAsync(Root)).Conflicted); Assert.Equal("manual merged ä", await Git(Root, "show", ":file.txt")); Assert.Single((await GitWorkspaceQuery.ReadAsync(Root, default)).Stashes);
    }

    [Fact]
    public async Task ModifyDeleteConflictCanChooseTheDeletedSide()
    {
        await Init(); await Git(Root, "switch", "-qc", "delete"); await Git(Root, "rm", "file.txt"); await Git(Root, "commit", "-qm", "delete");
        await Git(Root, "switch", "main"); await File.WriteAllTextAsync(Path.Combine(Root, "file.txt"), "ours\n"); await Git(Root, "commit", "-qam", "ours");
        var merge = await Request("merge"); merge.Branch = "refs/heads/delete"; Assert.Equal("conflicted", (await Execute(merge)).State);
        var view = await GitWorkspaceQuery.ReadConflictAsync(Root, "file.txt", default); var resolve = await Request("resolve-conflict"); resolve.Paths = ["file.txt"]; resolve.ExpectedFileVersion = view.ContentVersion; resolve.Resolution = "theirs";
        Assert.Equal("completed", (await Execute(resolve)).State); Assert.False(File.Exists(Path.Combine(Root, "file.txt"))); Assert.Empty((await GitCommandRunner.GetStatusAsync(Root)).Conflicted);
    }

    [Fact]
    public async Task AuthenticationFailureIsBoundedAndDoesNotExposeUrlCredentials()
    {
        await Init(); await Git(Root, "config", "credential.helper", "");
        using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0); listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var server = Task.Run(async () => {
            try {
                while (!cancellation.IsCancellationRequested) {
                    using var client = await listener.AcceptTcpClientAsync(cancellation.Token);
                    await using var stream = client.GetStream();
                    var buffer = new byte[16384]; await stream.ReadAsync(buffer, cancellation.Token);
                    await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), cancellation.Token);
                }
            } catch (OperationCanceledException) { }
        }, cancellation.Token);
        try {
            await Git(Root, "remote", "add", "auth", "http://user:private-secret@127.0.0.1:" + port.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/repo.git");
            var fetch = await Request("fetch"); fetch.Remote = "auth"; var result = await Execute(fetch);
            Assert.Equal("error", result.State); Assert.Equal("git_failed", result.ErrorCode); Assert.DoesNotContain("private-secret", result.Detail ?? "", StringComparison.Ordinal);
            Assert.Contains("Authentication failed", result.Detail ?? "", StringComparison.OrdinalIgnoreCase);
        } finally { cancellation.Cancel(); listener.Stop(); await server; }
    }
}
