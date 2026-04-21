using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitFileStatusMapBuilderTests
{
    [Fact]
    public void Build_IncludesFilesAndParentDirectories()
    {
        var status = new GitStatusResponse
        {
            Modified =
            [
                new GitFileEntry { Path = "src/modules/git/panel.ts", Status = "modified" }
            ],
            Untracked =
            [
                new GitFileEntry { Path = "notes/todo.md", Status = "untracked" }
            ]
        };

        var map = GitFileStatusMapBuilder.Build(status);

        Assert.Equal("M", map["src/modules/git/panel.ts"]);
        Assert.Equal("M", map["src/modules/git"]);
        Assert.Equal("M", map["src/modules"]);
        Assert.Equal("?", map["notes/todo.md"]);
        Assert.Equal("?", map["notes"]);
    }

    [Fact]
    public void Build_PrefersStrongerBadgesForDirectories()
    {
        var status = new GitStatusResponse
        {
            Untracked =
            [
                new GitFileEntry { Path = "src/new-file.ts", Status = "untracked" }
            ],
            Conflicted =
            [
                new GitFileEntry { Path = "src/conflicted.ts", Status = "conflicted" }
            ]
        };

        var map = GitFileStatusMapBuilder.Build(status);

        Assert.Equal("!", map["src"]);
        Assert.Equal("!", map["src/conflicted.ts"]);
        Assert.Equal("?", map["src/new-file.ts"]);
    }
}
