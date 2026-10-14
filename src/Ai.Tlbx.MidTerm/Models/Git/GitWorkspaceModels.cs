namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitWorkspaceResponse
{
    public string RepoRoot { get; set; } = "";
    public string CurrentBranch { get; set; } = "";
    public string HeadHash { get; set; } = "";
    public string IndexVersion { get; set; } = "";
    public GitBranchView[] Branches { get; set; } = [];
    public GitRemoteView[] Remotes { get; set; } = [];
    public GitStashView[] Stashes { get; set; } = [];
    public bool MergeInProgress { get; set; }
    public string MergeMessage { get; set; } = "";
}
public sealed class GitBranchView
{
    public string Name { get; set; } = "";
    public string Ref { get; set; } = "";
    public string Hash { get; set; } = "";
    public bool IsCurrent { get; set; }
    public bool IsRemote { get; set; }
}
public sealed class GitRemoteView { public string Name { get; set; } = ""; }
public sealed class GitStashView
{
    public string Ref { get; set; } = "";
    public string Hash { get; set; } = "";
    public string Message { get; set; } = "";
    public string Date { get; set; } = "";
}
public sealed class GitConflictView
{
    public string Path { get; set; } = "";
    public string ContentVersion { get; set; } = "";
    public bool IsBinary { get; set; }
    public bool HasMarkers { get; set; }
    public bool HasOurs { get; set; }
    public bool HasTheirs { get; set; }
    public string Base { get; set; } = "";
    public string Ours { get; set; } = "";
    public string Theirs { get; set; } = "";
    public bool IsTruncated { get; set; }
}
