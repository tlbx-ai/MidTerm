namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitStageRequest
{
    public string SessionId { get; set; } = "";
    public string[] Paths { get; set; } = [];
}

public sealed class GitUnstageRequest
{
    public string SessionId { get; set; } = "";
    public string[] Paths { get; set; } = [];
}

public sealed class GitCommitRequest
{
    public string SessionId { get; set; } = "";
    public string Message { get; set; } = "";
}

public sealed class GitPushPullRequest
{
    public string SessionId { get; set; } = "";
}

public sealed class GitStashRequest
{
    public string SessionId { get; set; } = "";
    public string Action { get; set; } = "";
    public string? Message { get; set; }
}

public sealed class GitDiscardRequest
{
    public string SessionId { get; set; } = "";
    public string[] Paths { get; set; } = [];
}

public sealed class GitDiffRequest
{
    public string SessionId { get; set; } = "";
    public string Path { get; set; } = "";
    public bool Staged { get; set; }
}
