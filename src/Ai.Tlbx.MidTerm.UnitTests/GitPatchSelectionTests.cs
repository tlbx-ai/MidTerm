using System.Text;
using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitPatchSelectionTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tlbx_patch_selection_" + Guid.NewGuid().ToString("N"));
    private readonly GitOperationService _operations = new();
    private readonly string[] _baseline = Enumerable.Range(1, 40).Select(line => "Baseline line " + line).ToArray();
    public GitPatchSelectionTests() => Directory.CreateDirectory(_root);
    public void Dispose()
    {
        if (!Path.GetFileName(_root).StartsWith("tlbx_patch_selection_", StringComparison.Ordinal)) throw new InvalidOperationException();
        if (OperatingSystem.IsWindows()) foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)) File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
        Directory.Delete(_root, recursive: true); GC.SuppressFinalize(this);
    }
    private void Write(string path, string text) => File.WriteAllText(Path.Combine(_root, path), text, new UTF8Encoding(false));
    private async Task<string> Git(params string[] args)
    {
        var result = await GitCommandRunner.ExecuteAsync(_root, args, default);
        Assert.True(result.ExitCode == 0, result.Stderr); return result.Stdout;
    }
    private async Task Init(string newline = "\n")
    {
        await Git("init", "--quiet"); await Git("config", "user.name", "Selected patch acceptance"); await Git("config", "user.email", "patch@tlbx.invalid");
        await Git("config", "commit.gpgSign", "false"); await Git("config", "core.autocrlf", "false");
        Write("a.txt", string.Join(newline, _baseline) + newline); await Git("add", "."); await Git("commit", "--quiet", "-m", "Baseline");
    }
    private async Task<(GitOperationRequest Request, GitPatchSnapshot Snapshot)> Review(string action, string path = "a.txt")
    {
        var status = await GitCommandRunner.GetStatusAsync(_root);
        var snapshot = await GitPatchSelection.ReadAsync(_root, path, action == "unstage-selection", status);
        Assert.True(snapshot.View.CanSelectLines);
        return (new GitOperationRequest { Action = action, Paths = [path], OperationId = Guid.NewGuid().ToString("D"), ExpectedIndexVersion = status.IndexVersion, ExpectedPatchVersion = snapshot.View.PatchVersion }, snapshot);
    }
    private Task<GitOperationResponse> Apply(GitOperationRequest request) => _operations.ExecuteAsync(_root, request, default);

    [Fact]
    public async Task SelectedHunksStageAndUnstageOnlyReviewedChangesAndPreserveWorkingBytes()
    {
        await Init(); var changed = (string[])_baseline.Clone(); changed[4] = "First changed ä"; changed[29] = "Second changed 字";
        var working = string.Join('\n', changed) + "\n"; Write("a.txt", working);
        var (request, snapshot) = await Review("stage-selection"); Assert.Equal(2, snapshot.View.Files[0].Hunks.Length); request.SelectedHunks = [0];
        Assert.Equal("completed", (await Apply(request)).State);
        var indexed = await Git("show", ":a.txt"); Assert.Contains("First changed ä", indexed, StringComparison.Ordinal); Assert.DoesNotContain("Second changed 字", indexed, StringComparison.Ordinal);
        Assert.Equal(working, File.ReadAllText(Path.Combine(_root, "a.txt")));
        var (undo, _) = await Review("unstage-selection"); undo.SelectedHunks = [0]; Assert.Equal("completed", (await Apply(undo)).State);
        Assert.Equal(string.Join('\n', _baseline) + "\n", await Git("show", ":a.txt")); Assert.Equal(working, File.ReadAllText(Path.Combine(_root, "a.txt")));
    }

    [Fact]
    public async Task IndividualAdditionCanBeStagedWithoutItsAdjacentDeletionAndWithoutChangingCrlfUnicode()
    {
        await Init("\r\n"); var changed = (string[])_baseline.Clone(); changed[4] = "Reviewed ä字😀";
        var working = string.Join("\r\n", changed) + "\r\n"; Write("a.txt", working);
        var (request, snapshot) = await Review("stage-selection"); var hunk = snapshot.View.Files[0].Hunks[0];
        var add = Array.FindIndex(hunk.Lines, line => line.Kind == "add"); request.SelectedLines = [new() { Hunk = 0, Line = add }];
        Assert.Equal("completed", (await Apply(request)).State);
        var expected = _baseline.ToList(); expected.Insert(5, "Reviewed ä字😀");
        Assert.Equal(string.Join("\r\n", expected) + "\r\n", await Git("show", ":a.txt"));
        Assert.Equal(Encoding.UTF8.GetBytes(working), await File.ReadAllBytesAsync(Path.Combine(_root, "a.txt"), Xunit.TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task ANewFileCanStageSelectedLinesAndUnstageOnlyOneOfThem()
    {
        await Init(); Write("new ä.txt", "First ä\nSecond 字\nThird 😀\n");
        var (request, _) = await Review("stage-selection", "new ä.txt"); request.SelectedLines = [new() { Hunk = 0, Line = 0 }, new() { Hunk = 0, Line = 2 }];
        Assert.Equal("completed", (await Apply(request)).State); Assert.Equal("First ä\nThird 😀\n", await Git("show", ":new ä.txt"));
        var (undo, _) = await Review("unstage-selection", "new ä.txt"); undo.SelectedLines = [new() { Hunk = 0, Line = 0 }];
        Assert.Equal("completed", (await Apply(undo)).State); Assert.Equal("Third 😀\n", await Git("show", ":new ä.txt"));
        var (all, _) = await Review("unstage-selection", "new ä.txt"); all.SelectedHunks = [0];
        Assert.Equal("completed", (await Apply(all)).State); Assert.Equal("", await Git("ls-files", "--", "new ä.txt"));
        Assert.Equal("First ä\nSecond 字\nThird 😀\n", File.ReadAllText(Path.Combine(_root, "new ä.txt")));
    }

    [Fact]
    public async Task ADeletedFileCanStageAndRestoreSelectedDeletedLinesWithoutRecreatingItsWorkingCopy()
    {
        await Init(); File.Delete(Path.Combine(_root, "a.txt"));
        var (request, _) = await Review("stage-selection"); request.SelectedLines = [new() { Hunk = 0, Line = 4 }];
        Assert.Equal("completed", (await Apply(request)).State); var expected = _baseline.Where((_, index) => index != 4);
        Assert.Equal(string.Join('\n', expected) + "\n", await Git("show", ":a.txt")); Assert.False(File.Exists(Path.Combine(_root, "a.txt")));
        var (undo, _) = await Review("unstage-selection"); undo.SelectedHunks = [0];
        Assert.Equal("completed", (await Apply(undo)).State); Assert.Equal(string.Join('\n', _baseline) + "\n", await Git("show", ":a.txt"));
        Assert.False(File.Exists(Path.Combine(_root, "a.txt")));
    }

    [Fact]
    public async Task SelectedUnstageOnARenamePreservesItsIndexedDestinationAndWorkingBytes()
    {
        await Init(); await Git("mv", "a.txt", "renamed ä.txt"); var changed = (string[])_baseline.Clone(); changed[19] = "Reviewed rename change 字";
        var working = string.Join('\n', changed) + "\n"; Write("renamed ä.txt", working); await Git("add", "--", "renamed ä.txt");
        var (request, snapshot) = await Review("unstage-selection", "renamed ä.txt"); Assert.Equal("renamed", snapshot.View.Files[0].Status);
        request.SelectedHunks = [0]; Assert.Equal("completed", (await Apply(request)).State);
        Assert.Equal(string.Join('\n', _baseline) + "\n", await Git("show", ":renamed ä.txt")); Assert.Equal("", await Git("ls-files", "--", "a.txt"));
        Assert.Equal("renamed", Assert.Single((await GitCommandRunner.GetStatusAsync(_root)).Staged).Status);
        Assert.Equal(working, File.ReadAllText(Path.Combine(_root, "renamed ä.txt")));
    }

    [Fact]
    public async Task StaleWorktreeOrIndexReviewsAreRejectedWithoutPublishingAnySelectedChanges()
    {
        await Init(); Write("a.txt", "Reviewed first\n"); var (old, _) = await Review("stage-selection"); old.SelectedHunks = [0];
        Write("a.txt", "New unreviewed text\n"); var result = await Apply(old); Assert.Equal("error", result.State); Assert.Equal("diff_changed", result.ErrorCode);
        Assert.Equal(string.Join('\n', _baseline) + "\n", await Git("show", ":a.txt"));
        var (indexOld, _) = await Review("stage-selection"); indexOld.SelectedHunks = [0];
        Write("other.txt", "Other external stage\n"); await Git("add", "other.txt"); var indexBefore = await GitCommandRunner.GetIndexVersionAsync(_root);
        result = await Apply(indexOld); Assert.Equal("index_changed", result.ErrorCode); Assert.Equal(indexBefore, await GitCommandRunner.GetIndexVersionAsync(_root));
    }

    [Fact]
    public async Task AnUnbornRepositoryStagesSelectedNewContentAndReplaysWithoutApplyingItTwice()
    {
        await Git("init", "--quiet"); await Git("config", "core.autocrlf", "false");
        Write("new.txt", "First\nSecond 字\nThird\n");
        var (request, _) = await Review("stage-selection", "new.txt"); request.SelectedLines = [new() { Hunk = 0, Line = 1 }];
        Assert.Equal("completed", (await Apply(request)).State); var version = await GitCommandRunner.GetIndexVersionAsync(_root);
        Assert.Equal("Second 字\n", await Git("show", ":new.txt")); Assert.Equal("completed", (await Apply(request)).State);
        Assert.Equal(version, await GitCommandRunner.GetIndexVersionAsync(_root)); Assert.Equal("First\nSecond 字\nThird\n", File.ReadAllText(Path.Combine(_root, "new.txt")));
    }

    [Fact]
    public async Task ContextOrOutOfRangeSelectionsAreRejectedWithoutPublishingAnIndex()
    {
        await Init(); var changed = (string[])_baseline.Clone(); changed[4] = "Actual replacement"; Write("a.txt", string.Join('\n', changed) + "\n");
        var version = await GitCommandRunner.GetIndexVersionAsync(_root);
        var (context, _) = await Review("stage-selection"); context.SelectedLines = [new() { Hunk = 0, Line = 0 }];
        var result = await Apply(context); Assert.Equal("invalid_selection", result.ErrorCode); Assert.Equal(400, result.StatusCode);
        var (outside, _) = await Review("stage-selection"); outside.SelectedHunks = [999]; result = await Apply(outside);
        Assert.Equal("invalid_selection", result.ErrorCode); Assert.Equal(version, await GitCommandRunner.GetIndexVersionAsync(_root));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_root, ".git"), "*.tlbx-*"));
    }

    [Fact]
    public async Task ConcurrentSelectionsPublishOneReviewedIndexAndRejectTheStalePeer()
    {
        await Init(); var changed = (string[])_baseline.Clone(); changed[4] = "First concurrent"; changed[29] = "Second concurrent"; Write("a.txt", string.Join('\n', changed) + "\n");
        var (first, _) = await Review("stage-selection"); var (second, _) = await Review("stage-selection"); first.SelectedHunks = [0]; second.SelectedHunks = [1];
        var results = await Task.WhenAll(Apply(first), Apply(second)); Assert.Single(results, result => result.State == "completed"); Assert.Single(results, result => result.ErrorCode == "index_changed");
        var indexed = await Git("show", ":a.txt"); Assert.True(indexed.Contains("First concurrent", StringComparison.Ordinal) ^ indexed.Contains("Second concurrent", StringComparison.Ordinal));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_root, ".git"), "*.tlbx-*"));
    }
}
