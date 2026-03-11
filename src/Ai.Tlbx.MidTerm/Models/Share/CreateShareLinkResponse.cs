namespace Ai.Tlbx.MidTerm.Models.Share;

public sealed class CreateShareLinkResponse
{
    public string ShareUrl { get; init; } = "";
    public string GrantId { get; init; } = "";
    public ShareAccessMode Mode { get; init; }
    public DateTime ExpiresAtUtc { get; init; }
}
