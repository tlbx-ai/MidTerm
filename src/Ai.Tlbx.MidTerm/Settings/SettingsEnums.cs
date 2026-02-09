using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Settings;

public enum CursorStyleSetting
{
    [JsonStringEnumMemberName("bar")] Bar,
    [JsonStringEnumMemberName("block")] Block,
    [JsonStringEnumMemberName("underline")] Underline
}

public enum CursorInactiveStyleSetting
{
    [JsonStringEnumMemberName("outline")] Outline,
    [JsonStringEnumMemberName("block")] Block,
    [JsonStringEnumMemberName("bar")] Bar,
    [JsonStringEnumMemberName("underline")] Underline,
    [JsonStringEnumMemberName("none")] None
}

public enum ThemeSetting
{
    [JsonStringEnumMemberName("dark")] Dark,
    [JsonStringEnumMemberName("light")] Light,
    [JsonStringEnumMemberName("solarizedDark")] SolarizedDark,
    [JsonStringEnumMemberName("solarizedLight")] SolarizedLight
}

public enum BellStyleSetting
{
    [JsonStringEnumMemberName("notification")] Notification,
    [JsonStringEnumMemberName("sound")] Sound,
    [JsonStringEnumMemberName("visual")] Visual,
    [JsonStringEnumMemberName("both")] Both,
    [JsonStringEnumMemberName("off")] Off
}

public enum ClipboardShortcutsSetting
{
    [JsonStringEnumMemberName("auto")] Auto,
    [JsonStringEnumMemberName("windows")] Windows,
    [JsonStringEnumMemberName("unix")] Unix
}

public enum KeyProtectionMethod
{
    [JsonStringEnumMemberName("osProtected")] OsProtected,
    [JsonStringEnumMemberName("legacyPfx")] LegacyPfx
}

public enum TabTitleModeSetting
{
    [JsonStringEnumMemberName("hostname")] Hostname,
    [JsonStringEnumMemberName("static")] Static,
    [JsonStringEnumMemberName("sessionName")] SessionName,
    [JsonStringEnumMemberName("terminalTitle")] TerminalTitle,
    [JsonStringEnumMemberName("foregroundProcess")] ForegroundProcess
}

public enum ScrollbarStyleSetting
{
    [JsonStringEnumMemberName("off")] Off,
    [JsonStringEnumMemberName("hover")] Hover,
    [JsonStringEnumMemberName("always")] Always
}
