namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitDiffViewResponse
{
    public string Scope { get; set; } = "";
    public string Title { get; set; } = "";
    public bool IsTruncated { get; set; }
    public GitDiffFileView[] Files { get; set; } = [];
}

public sealed class GitCommitDetailsResponse
{
    public string Hash { get; set; } = "";
    public string ShortHash { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Body { get; set; } = "";
    public string Author { get; set; } = "";
    public string AuthoredDate { get; set; } = "";
    public string CommittedDate { get; set; } = "";
    public string[] ParentHashes { get; set; } = [];
    public int TotalAdditions { get; set; }
    public int TotalDeletions { get; set; }
    public bool IsTruncated { get; set; }
    public GitDiffFileView[] Files { get; set; } = [];
}

public sealed class GitDiffFileView
{
    public string Path { get; set; } = "";
    public string? OriginalPath { get; set; }
    public string Status { get; set; } = "";
    public int Additions { get; set; }
    public int Deletions { get; set; }
    public bool IsBinary { get; set; }
    public bool IsTruncated { get; set; }
    public GitDiffHunk[] Hunks { get; set; } = [];
}

public sealed class GitDiffHunk
{
    public string Header { get; set; } = "";
    public GitDiffLine[] Lines { get; set; } = [];
}

public sealed class GitDiffLine
{
    public string Kind { get; set; } = "";
    public string Text { get; set; } = "";
}
