using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitFileStatusMapTests
{
    [Fact]
    public void AllStatesRetainTheirBadgeAndPropagateToExistingParentFolders()
    {
        var status = new GitStatusResponse
        {
            Conflicted = [new() { Path = "conflict/deep/file.txt", Status = "conflicted" }],
            Staged = [
                new() { Path = "added/file.txt", Status = "added" },
                new() { Path = "renamed/new file.txt", OriginalPath = "old file.txt", Status = "renamed" },
                new() { Path = "copied/file.txt", Status = "copied" }
            ],
            Modified = [
                new() { Path = "modified/file.txt", Status = "modified" },
                new() { Path = "deleted/missing.txt", Status = "deleted" },
                new() { Path = "type/file", Status = "type-changed" }
            ],
            Untracked = [new() { Path = "untracked/file.txt", Status = "untracked" }]
        };
        var map = GitFileStatusMapBuilder.Build(status);
        foreach (var (folder, badge) in new[] { ("conflict", "!"), ("added", "A"), ("renamed", "R"), ("copied", "C"), ("modified", "M"), ("deleted", "D"), ("type", "T"), ("untracked", "U") })
            Assert.Equal(badge, map[folder]);
        Assert.Equal("!", map["conflict/deep"]);
        Assert.Equal("R", map["renamed/new file.txt"]);
        Assert.False(map.ContainsKey("old file.txt"));
    }

    [Fact]
    public void ConflictAndWorktreeChangesTakePriorityOverStagedAndUntracked()
    {
        var status = new GitStatusResponse
        {
            Conflicted = [new() { Path = "shared/conflict", Status = "conflicted" }],
            Staged = [new() { Path = "shared/added", Status = "added" }],
            Modified = [new() { Path = "shared/added", Status = "modified" }],
            Untracked = [new() { Path = "shared/untracked", Status = "untracked" }]
        };
        var map = GitFileStatusMapBuilder.Build(status);
        Assert.Equal("!", map["shared"]);
        Assert.Equal("M", map["shared/added"]);
        Assert.Equal("U", map["shared/untracked"]);
    }

    [Fact]
    public void UnixPathsRetainLiteralBackslashesAndCaseDistinctEntries()
    {
        var map = GitFileStatusMapBuilder.Build(new GitStatusResponse
        {
            Modified = [new() { Path = "name\\literal/file.txt", Status = "modified" }, new() { Path = "Case.txt", Status = "modified" }, new() { Path = " ", Status = "modified" }],
            Untracked = [new() { Path = "case.txt", Status = "untracked" }]
        });
        Assert.Equal("M", map["name\\literal/file.txt"]);
        Assert.Equal("M", map["name\\literal"]);
        Assert.Equal("M", map[" "]);
        if (!OperatingSystem.IsWindows()) Assert.Equal("U", map["case.txt"]);
    }
}
