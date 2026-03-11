using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models.Share;

public sealed class ShareBootstrapResponse
{
    public string Hostname { get; init; } = "";
    public SessionInfoDto? Session { get; init; }
    public MidTermSettingsPublic Settings { get; init; } = new();
    public ShareAccessMode Mode { get; init; }
    public DateTime ExpiresAtUtc { get; init; }
}
