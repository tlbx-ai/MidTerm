using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitStatusParserTests
{
    [Fact]
    public void NulRecordsPreserveSpacesUnicodeAndLiteralControlCharacters()
    {
        const string path = "deep folder/quoted \"ä😀\"\tline\nname.txt";
        var status = GitCommandRunner.ParseStatus("fixture", $"# branch.head main\0# branch.ab +2 -3\01 MM N... 100644 100644 100644 a b {path}\0? new name\nfile.txt\0");
        Assert.Equal("main", status.Branch);
        Assert.Equal(2, status.Ahead); Assert.Equal(3, status.Behind);
        Assert.Equal(path, Assert.Single(status.Staged).Path);
        Assert.Equal(path, Assert.Single(status.Modified).Path);
        Assert.Equal("new name\nfile.txt", Assert.Single(status.Untracked).Path);
    }

    [Fact]
    public void RenameConsumesItsOriginalPathAndKeepsBothPathsInOrder()
    {
        var status = GitCommandRunner.ParseStatus("fixture", "2 RM N... 100644 100644 100644 a b R100 new folder/ö.txt\0old folder/ä.txt\0? following.txt\0");
        var staged = Assert.Single(status.Staged);
        Assert.Equal("new folder/ö.txt", staged.Path); Assert.Equal("old folder/ä.txt", staged.OriginalPath); Assert.Equal("renamed", staged.Status);
        var modified = Assert.Single(status.Modified);
        Assert.Equal(staged.Path, modified.Path); Assert.Equal(staged.OriginalPath, modified.OriginalPath);
        Assert.Equal("following.txt", Assert.Single(status.Untracked).Path);
    }

    [Fact]
    public void ConflictPathsAreNotSplitOrTrimmed()
    {
        const string path = "folder with spaces/ name with trailing space ";
        var status = GitCommandRunner.ParseStatus("fixture", $"u UU N... 100644 100644 100644 100644 a b c {path}\0");
        Assert.Equal(path, Assert.Single(status.Conflicted).Path);
    }
}
