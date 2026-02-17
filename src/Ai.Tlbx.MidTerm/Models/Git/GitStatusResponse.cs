namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitStatusResponse
{
    public string Branch { get; set; } = "";
    public int Ahead { get; set; }
    public int Behind { get; set; }
    public GitFileEntry[] Staged { get; set; } = [];
    public GitFileEntry[] Modified { get; set; } = [];
    public GitFileEntry[] Untracked { get; set; } = [];
    public GitFileEntry[] Conflicted { get; set; } = [];
    public GitLogEntry[] RecentCommits { get; set; } = [];
    public int StashCount { get; set; }
    public string RepoRoot { get; set; } = "";
}

public sealed class GitFileEntry
{
    public string Path { get; set; } = "";
    public string Status { get; set; } = "";
    public string? OriginalPath { get; set; }
}

public sealed class GitLogEntry
{
    public string Hash { get; set; } = "";
    public string ShortHash { get; set; } = "";
    public string Message { get; set; } = "";
    public string Author { get; set; } = "";
    public string Date { get; set; } = "";
}
