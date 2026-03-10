namespace Ai.Tlbx.MidTerm.Models.Share;

public sealed class ClaimShareResponse
{
    public string GrantId { get; init; } = "";
    public string SessionId { get; init; } = "";
    public ShareAccessMode Mode { get; init; }
    public DateTime ExpiresAtUtc { get; init; }
}
