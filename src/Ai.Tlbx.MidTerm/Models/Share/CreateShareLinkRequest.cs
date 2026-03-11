namespace Ai.Tlbx.MidTerm.Models.Share;

public sealed class CreateShareLinkRequest
{
    public string SessionId { get; init; } = "";
    public ShareAccessMode Mode { get; init; } = ShareAccessMode.FullControl;
}
