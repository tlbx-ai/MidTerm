using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitCommitComparisonTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tlbx_commit_comparison_" + Guid.NewGuid().ToString("N"));
    public GitCommitComparisonTests() => Directory.CreateDirectory(_root);
    public void Dispose()
    {
        if (!Path.GetFileName(_root).StartsWith("tlbx_commit_comparison_", StringComparison.Ordinal)) throw new InvalidOperationException();
        if (OperatingSystem.IsWindows()) foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)) File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
        Directory.Delete(_root, recursive: true); GC.SuppressFinalize(this);
    }
    private void Write(string path, string text) => File.WriteAllText(Path.Combine(_root, path), text);
    private async Task<string> Git(params string[] args)
    {
        var result = await GitCommandRunner.ExecuteAsync(_root, args, default); Assert.True(result.ExitCode == 0, result.Stderr); return result.Stdout.TrimEnd('\r', '\n');
    }
    private async Task<string> Init(string format = "sha1")
    {
        await Git("init", "--quiet", "--initial-branch=main", "--object-format=" + format);
        await Git("config", "user.name", "Commit comparison acceptance"); await Git("config", "user.email", "comparison@tlbx.invalid"); await Git("config", "commit.gpgSign", "false");
        await Git("config", "core.autocrlf", "false"); Directory.CreateDirectory(Path.Combine(_root, "folder"));
        Write("root.txt", "Root ä\n"); Write("folder/nested.txt", "Nested 字\n"); await Git("add", "."); await Git("commit", "--quiet", "-m", "Root commit");
        return await Git("rev-parse", "HEAD");
    }
    private async Task<GitCommitDetailsResponse> Inspect(string reference, int parentIndex = 0)
    {
        var metadata = await GitCommandRunner.GetCommitMetadataAsync(_root, reference); Assert.NotNull(metadata);
        var parent = metadata.ParentHashes.Length == 0 ? null : metadata.ParentHashes[parentIndex];
        var patch = await GitCommandRunner.GetCommitPatchAsync(_root, metadata.Hash, parent);
        Assert.False(patch.IsTruncated); return GitPatchParser.ParseCommitDetails(metadata, patch.Patch, false, parentIndex);
    }

    [Theory]
    [InlineData("sha1")]
    [InlineData("sha256")]
    public async Task RootCommitComparesRecursivelyAgainstTheEmptyTreeInTheRepositoryObjectFormat(string format)
    {
        var hash = await Init(format); await Git("config", "diff.noprefix", "true"); var response = await Inspect("HEAD"); Assert.Equal(hash, response.Hash); Assert.True(response.IsRootCommit);
        Assert.Null(response.ComparedParentHash); Assert.Null(response.ComparedParentIndex); Assert.Empty(response.ParentHashes);
        Assert.Equal(2, response.Files.Length); Assert.Equal(2, response.TotalAdditions); Assert.Equal(0, response.TotalDeletions);
        Assert.Contains(response.Files, file => file.Path == "folder/nested.txt" && file.Status == "added");
        Assert.Equal(format == "sha1" ? 40 : 64, response.Hash.Length);
    }

    [Fact]
    public async Task NormalAndEmptyCommitsReportTheExplicitParentAndItsActualPatch()
    {
        var root = await Init(); Write("root.txt", "Normal reviewed content ä\n"); await Git("add", "."); await Git("commit", "--quiet", "-m", "Normal commit");
        var normal = await Inspect("HEAD"); Assert.False(normal.IsRootCommit); Assert.Equal(root, normal.ComparedParentHash); Assert.Equal(0, normal.ComparedParentIndex);
        Assert.Equal(1, normal.TotalAdditions); Assert.Equal(1, normal.TotalDeletions); Assert.Equal("root.txt", Assert.Single(normal.Files).Path);
        await Git("commit", "--quiet", "--allow-empty", "-m", "Empty comparison"); var empty = await Inspect("HEAD");
        Assert.Equal(normal.Hash, empty.ComparedParentHash); Assert.Empty(empty.Files); Assert.Equal(0, empty.TotalAdditions); Assert.Equal(0, empty.TotalDeletions);
    }

    [Fact]
    public async Task MergeCommitSwitchesBetweenBothRealParentTreesAndTheirDistinctStatistics()
    {
        await Init(); await Git("switch", "--quiet", "-c", "side"); Write("side.txt", "Side first 字\nSide second ä\n"); await Git("add", "."); await Git("commit", "--quiet", "-m", "Side changes"); var side = await Git("rev-parse", "HEAD");
        await Git("switch", "--quiet", "main"); Write("main.txt", "Main content\n"); await Git("add", "."); await Git("commit", "--quiet", "-m", "Main changes"); var main = await Git("rev-parse", "HEAD");
        await Git("merge", "--quiet", "--no-ff", "side", "-m", "Merge both parents");
        var first = await Inspect("HEAD", 0); var second = await Inspect("HEAD", 1);
        Assert.Equal(new[] { main, side }, first.ParentHashes, StringComparer.Ordinal); Assert.Equal(main, first.ComparedParentHash); Assert.Equal(side, second.ComparedParentHash);
        Assert.Equal("side.txt", Assert.Single(first.Files).Path); Assert.Equal(2, first.TotalAdditions);
        Assert.Equal("main.txt", Assert.Single(second.Files).Path); Assert.Equal(1, second.TotalAdditions);
        Assert.Equal(0, first.ComparedParentIndex); Assert.Equal(1, second.ComparedParentIndex);
    }

    [Fact]
    public async Task AFailedComparisonCannotBeReportedAsAnEmptySuccessfulDiff()
    {
        var hash = await Init();
        await Assert.ThrowsAsync<IOException>(() => GitCommandRunner.GetCommitPatchAsync(_root, hash, new string('f', 40)));
    }

    [Fact]
    public async Task ACommitReferenceCannotBeInterpretedAsAGitOutputOption()
    {
        await Init(); var marker = Path.Combine(_root, "must-not-be-created.txt");
        Assert.Null(await GitCommandRunner.GetCommitMetadataAsync(_root, "--output=" + marker)); Assert.False(File.Exists(marker));
        Assert.NotNull(await GitCommandRunner.GetCommitMetadataAsync(_root, "HEAD"));
    }
}
