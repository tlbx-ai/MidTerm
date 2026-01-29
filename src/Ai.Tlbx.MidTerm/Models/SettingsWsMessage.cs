using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models;

public sealed class SettingsWsMessage
{
    public string Type { get; init; } = "";
    public MidTermSettingsPublic? Settings { get; init; }
    public UpdateInfo? Update { get; init; }
}
