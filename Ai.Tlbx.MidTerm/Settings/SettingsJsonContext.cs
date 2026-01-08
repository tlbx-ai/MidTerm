using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Settings;

[JsonSerializable(typeof(MidTermSettings))]
[JsonSerializable(typeof(CursorStyleSetting))]
[JsonSerializable(typeof(ThemeSetting))]
[JsonSerializable(typeof(BellStyleSetting))]
[JsonSerializable(typeof(ClipboardShortcutsSetting))]
[JsonSerializable(typeof(LogSeverity))]
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true,
    UseStringEnumConverter = true)]
public partial class SettingsJsonContext : JsonSerializerContext
{
}
