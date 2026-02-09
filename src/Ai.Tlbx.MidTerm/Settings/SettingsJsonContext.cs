using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Settings;

[JsonSerializable(typeof(MidTermSettings))]
[JsonSerializable(typeof(CursorStyleSetting))]
[JsonSerializable(typeof(ThemeSetting))]
[JsonSerializable(typeof(BellStyleSetting))]
[JsonSerializable(typeof(ClipboardShortcutsSetting))]
[JsonSerializable(typeof(ScrollbarStyleSetting))]
[JsonSerializable(typeof(KeyProtectionMethod))]
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true,
    UseStringEnumConverter = true)]
public partial class SettingsJsonContext : JsonSerializerContext
{
}
