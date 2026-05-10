namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitStatusResponse
{
    public string Label { get; set; } = "";
    public string Role { get; set; } = "";
    public string Source { get; set; } = "";
    public bool IsPrimary { get; set; }
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
    public int TotalAdditions { get; set; }
    public int TotalDeletions { get; set; }
}

public sealed class GitRepoBinding
{
    public string RepoRoot { get; set; } = "";
    public string Label { get; set; } = "";
    public string Role { get; set; } = "";
    public string Source { get; set; } = "";
    public bool IsPrimary { get; set; }
    public GitStatusResponse? Status { get; set; }
}

public sealed class GitRepoListResponse
{
    public GitRepoBinding[] Repos { get; set; } = [];
}

public sealed class GitRepoBindRequest
{
    public string SessionId { get; set; } = "";
    public string Path { get; set; } = "";
    public string? Label { get; set; }
    public string? Role { get; set; }
}

public sealed class GitRepoRefreshRequest
{
    public string SessionId { get; set; } = "";
    public string? RepoRoot { get; set; }
}

public sealed class GitFileEntry
{
    public string Path { get; set; } = "";
    public string Status { get; set; } = "";
    public string? OriginalPath { get; set; }
    public int Additions { get; set; }
    public int Deletions { get; set; }
}

public sealed class GitLogEntry
{
    public string Hash { get; set; } = "";
    public string ShortHash { get; set; } = "";
    public string Message { get; set; } = "";
    public string Author { get; set; } = "";
    public string Date { get; set; } = "";
}
