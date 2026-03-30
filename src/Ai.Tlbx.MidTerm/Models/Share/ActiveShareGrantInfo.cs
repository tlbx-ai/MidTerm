namespace Ai.Tlbx.MidTerm.Models.Share;

public sealed class ActiveShareGrantInfo
{
    public string GrantId { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string SessionName { get; set; } = "";
    public ShareAccessMode Mode { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime ExpiresAtUtc { get; set; }
}
