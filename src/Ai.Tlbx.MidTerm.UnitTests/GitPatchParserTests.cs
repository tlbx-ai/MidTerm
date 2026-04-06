using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitPatchParserTests
{
    [Fact]
    public void ParseDiff_ParsesRenameAndHunks()
    {
        const string patch = """
diff --git a/src/old name.ts b/src/new name.ts
similarity index 88%
rename from src/old name.ts
rename to src/new name.ts
index 123..456 100644
--- a/src/old name.ts
+++ b/src/new name.ts
@@ -1,2 +1,3 @@
 line 1
-line 2
+line 2 changed
+line 3
""";

        var response = GitPatchParser.ParseDiff("worktree", patch, isTruncated: false);

        var file = Assert.Single(response.Files);
        Assert.Equal("worktree", response.Scope);
        Assert.Equal("renamed", file.Status);
        Assert.Equal("src/new name.ts", file.Path);
        Assert.Equal("src/old name.ts", file.OriginalPath);
        Assert.Equal(2, file.Additions);
        Assert.Equal(1, file.Deletions);
        Assert.Single(file.Hunks);
        Assert.Equal("@@ -1,2 +1,3 @@", file.Hunks[0].Header);
    }

    [Fact]
    public void ParseDiff_MarksBinaryFiles()
    {
        const string patch = """
diff --git a/assets/logo.png b/assets/logo.png
index 123..456 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
""";

        var response = GitPatchParser.ParseDiff("worktree", patch, isTruncated: true);

        var file = Assert.Single(response.Files);
        Assert.True(response.IsTruncated);
        Assert.True(file.IsBinary);
        Assert.True(file.IsTruncated);
        Assert.Equal("assets/logo.png", file.Path);
        Assert.Empty(file.Hunks);
    }

    [Fact]
    public void ParseCommitDetails_MapsMetadataAndTotals()
    {
        var metadata = new GitCommitMetadata
        {
            Hash = "abc123",
            ShortHash = "abc123",
            Subject = "Improve parser",
            Body = "Adds structured diff output.",
            Author = "MidTerm",
            AuthoredDate = "2026-04-06T10:00:00+00:00",
            CommittedDate = "2026-04-06T10:05:00+00:00",
            ParentHashes = ["parent1", "parent2"]
        };

        const string patch = """
diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
-old
+new
+extra
""";

        var response = GitPatchParser.ParseCommitDetails(metadata, patch, isTruncated: false);

        Assert.Equal("abc123", response.Hash);
        Assert.Equal("Improve parser", response.Subject);
        Assert.Equal("Adds structured diff output.", response.Body);
        Assert.Equal(new[] { "parent1", "parent2" }, response.ParentHashes);
        Assert.Equal(2, response.TotalAdditions);
        Assert.Equal(1, response.TotalDeletions);
        Assert.Single(response.Files);
    }
}
