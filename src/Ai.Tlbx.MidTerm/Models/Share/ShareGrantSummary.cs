namespace Ai.Tlbx.MidTerm.Models.Share;

public sealed class ShareGrantSummary
{
    public string GrantId { get; init; } = "";
    public string SessionId { get; init; } = "";
    public ShareAccessMode Mode { get; init; }
    public DateTime CreatedAtUtc { get; init; }
    public DateTime ExpiresAtUtc { get; init; }
}
