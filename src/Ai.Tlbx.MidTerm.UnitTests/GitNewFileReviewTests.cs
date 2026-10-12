using System.Text;
using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitNewFileReviewTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tlbx_new_file_" + Guid.NewGuid().ToString("N"));
    public GitNewFileReviewTests() => Directory.CreateDirectory(_root);
    public void Dispose()
    {
        if (!Path.GetFileName(_root).StartsWith("tlbx_new_file_", StringComparison.Ordinal)) throw new InvalidOperationException();
        if (OperatingSystem.IsWindows()) foreach (var path in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories)) File.SetAttributes(path, File.GetAttributes(path) & ~FileAttributes.ReadOnly);
        Directory.Delete(_root, recursive: true); GC.SuppressFinalize(this);
    }

    [Theory]
    [InlineData("utf8")]
    [InlineData("utf8-bom")]
    [InlineData("utf16")]
    public async Task NewTextReviewDecodesTheActualFileAndBuildsAdditionsAgainstEmpty(string encoding)
    {
        var codec = encoding switch { "utf8-bom" => (Encoding)new UTF8Encoding(true), "utf16" => new UnicodeEncoding(false, true), _ => new UTF8Encoding(false) };
        var path = Path.Combine(_root, "new ä.txt"); await File.WriteAllTextAsync(path, "First ä\r\nSecond 字\r\n", codec);
        var bytes = await File.ReadAllBytesAsync(path); var response = await GitNewFileReview.ReadAsync(_root, "new ä.txt", default);
        var file = Assert.Single(response.Files); Assert.True(file.IsNewFile); Assert.False(file.IsBinary); Assert.Equal(2, file.Additions); Assert.Equal(0, file.Deletions);
        Assert.Equal(bytes.Length, file.SizeBytes); Assert.True(file.HasLineStats); Assert.NotNull(file.ContentVersion);
        Assert.Equal(new[] { "+First ä", "+Second 字" }, Assert.Single(file.Hunks).Lines.Select(line => line.Text), StringComparer.Ordinal);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
    }

    [Fact]
    public async Task BinaryAndEmptyFilesHaveHonestMetadataAndNoInventedText()
    {
        await File.WriteAllBytesAsync(Path.Combine(_root, "new.bin"), [0, 255, 1, 2]);
        await File.WriteAllBytesAsync(Path.Combine(_root, "empty.txt"), []);
        var binary = Assert.Single((await GitNewFileReview.ReadAsync(_root, "new.bin", default)).Files);
        Assert.True(binary.IsBinary); Assert.False(binary.HasLineStats); Assert.Equal(4, binary.SizeBytes); Assert.Empty(binary.Hunks);
        var empty = Assert.Single((await GitNewFileReview.ReadAsync(_root, "empty.txt", default)).Files);
        Assert.False(empty.IsBinary); Assert.True(empty.HasLineStats); Assert.Equal(0, empty.SizeBytes); Assert.Equal(0, empty.Additions); Assert.Empty(empty.Hunks);
    }

    [Fact]
    public async Task LargeTextIsBoundedAndClearlyNotACompleteLineCount()
    {
        await File.WriteAllTextAsync(Path.Combine(_root, "large.txt"), string.Concat(Enumerable.Repeat("Large reviewed line ä\n", 100000)));
        var response = await GitNewFileReview.ReadAsync(_root, "large.txt", default); var file = Assert.Single(response.Files);
        Assert.True(response.IsTruncated); Assert.True(file.IsTruncated); Assert.False(file.HasLineStats); Assert.Null(file.ContentVersion);
        Assert.True(file.SizeBytes > 2_000_000); Assert.True(file.Hunks.SelectMany(hunk => hunk.Lines).Sum(line => line.Text.Length) < 600000);
    }

    [Fact]
    public async Task UntrackedDirectoryFilesAreListedIndividuallyAndReviewedBytesCommitUnchanged()
    {
        foreach (var args in new[] { new[] { "init", "--quiet" }, ["config", "user.name", "New file acceptance"], ["config", "user.email", "new@tlbx.invalid"], ["config", "commit.gpgSign", "false"] })
            Assert.Equal(0, (await GitCommandRunner.ExecuteAsync(_root, args, default)).ExitCode);
        Directory.CreateDirectory(Path.Combine(_root, "folder")); await File.WriteAllTextAsync(Path.Combine(_root, "folder", "new.txt"), "Reviewed content\n");
        var status = await GitCommandRunner.GetStatusAsync(_root); Assert.Equal("folder/new.txt", Assert.Single(status.Untracked).Path);
        var review = await GitNewFileReview.ReadAsync(_root, "folder/new.txt", default); Assert.Equal("+Reviewed content", Assert.Single(Assert.Single(Assert.Single(review.Files).Hunks).Lines).Text);
        var operations = new GitOperationService();
        var staged = await operations.ExecuteAsync(_root, new GitOperationRequest { Action = "stage", Paths = ["folder/new.txt"], OperationId = Guid.NewGuid().ToString("D") }, default);
        Assert.Equal("completed", staged.State); status = await GitCommandRunner.GetStatusAsync(_root);
        var committed = await operations.ExecuteAsync(_root, new GitOperationRequest { Action = "commit", Message = "Reviewed new file", ExpectedHead = status.HeadHash, ExpectedIndexVersion = status.IndexVersion, OperationId = Guid.NewGuid().ToString("D") }, default);
        Assert.Equal("completed", committed.State);
        var text = await GitCommandRunner.ExecuteAsync(_root, ["show", "HEAD:folder/new.txt"], default); Assert.Equal("Reviewed content\n", text.Stdout.Replace("\r\n", "\n", StringComparison.Ordinal));
    }

    [UnixFact]
    public async Task ANewSymlinkReviewsTheLinkTextWithoutFollowingAnOutsideTarget()
    {
        var target = Path.Combine(Path.GetTempPath(), "tlbx_outside_link_" + Guid.NewGuid().ToString("N") + ".txt");
        await File.WriteAllTextAsync(target, "Must not appear in review");
        try
        {
            File.CreateSymbolicLink(Path.Combine(_root, "new-link"), target);
            var file = Assert.Single((await GitNewFileReview.ReadAsync(_root, "new-link", default)).Files);
            Assert.Equal("inode/symlink", file.MimeType);
            Assert.DoesNotContain(file.Hunks.SelectMany(hunk => hunk.Lines), line => line.Text.Contains("Must not appear", StringComparison.Ordinal));
            Assert.Equal("+" + target, file.Hunks[0].Lines[0].Text);
        }
        finally { File.Delete(target); }
    }

    [Fact]
    public async Task AnOutsidePathIsRejectedBeforeRead()
    {
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => GitNewFileReview.ReadAsync(_root, "../outside.txt", default));
    }
}
