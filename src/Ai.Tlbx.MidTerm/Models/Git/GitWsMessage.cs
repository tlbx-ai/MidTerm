namespace Ai.Tlbx.MidTerm.Models.Git;

public sealed class GitWsMessage
{
    public string Type { get; set; } = "";
    public string SessionId { get; set; } = "";
    public GitStatusResponse? Status { get; set; }
    public string? Diff { get; set; }
    public string? Error { get; set; }
}
