using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitDiffProjectionTests
{
    [Fact]
    public void CoordinatesFollowActualOldAndNewHunkRangesAndMissingNewlineDoesNotConsumeALine()
    {
        const string patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -7,3 +12,4 @@\n same\n-before ä\n+after 字\n+extra\n end\n\\ No newline at end of file\n";
        var hunk = Assert.Single(Assert.Single(GitPatchParser.ParseDiff("worktree", patch, false).Files).Hunks);
        Assert.Equal(7, hunk.OldStart); Assert.Equal(12, hunk.NewStart);
        Assert.Equal(new int?[] { 7, 8, null, null, 9, null }, hunk.Lines.Select(line => line.OldLine));
        Assert.Equal(new int?[] { 12, null, 13, 14, 15, null }, hunk.Lines.Select(line => line.NewLine));
    }

    [Fact]
    public void WordComparisonPreservesUnicodeTextAndFindsSeparatedChanges()
    {
        const string patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-Hallo alte Welt und ä\n+Hallo neue Welt und 字\n";
        var lines = Assert.Single(Assert.Single(GitPatchParser.ParseDiff("worktree", patch, false).Files).Hunks).Lines;
        Assert.Equal("Hallo alte Welt und ä", string.Concat(lines[0].Segments.Select(segment => segment.Text)));
        Assert.Equal("Hallo neue Welt und 字", string.Concat(lines[1].Segments.Select(segment => segment.Text)));
        Assert.Equal("alteä", string.Concat(lines[0].Segments.Where(segment => segment.Changed).Select(segment => segment.Text)));
        Assert.Equal("neue字", string.Concat(lines[1].Segments.Where(segment => segment.Changed).Select(segment => segment.Text)));
        Assert.Contains(lines[1].Segments, segment => !segment.Changed && segment.Text.Contains("Welt", StringComparison.Ordinal));
    }

    [Fact]
    public void LongLinesKeepCoordinatesWithoutAnUnboundedWordComparison()
    {
        var patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-" + new string('a', 10000) + "\n+" + new string('b', 10000) + "\n";
        var lines = Assert.Single(Assert.Single(GitPatchParser.ParseDiff("worktree", patch, false).Files).Hunks).Lines;
        Assert.Equal(1, lines[0].OldLine); Assert.Equal(1, lines[1].NewLine);
        Assert.Empty(lines[0].Segments); Assert.Empty(lines[1].Segments);
    }
}
