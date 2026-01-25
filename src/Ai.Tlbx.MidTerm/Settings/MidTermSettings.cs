using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Shells;

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

public sealed class MidTermSettings
{
    // Session Defaults
    public ShellType DefaultShell { get; set; } = GetPlatformDefaultShell();
    public int DefaultCols { get; set; } = 120;
    public int DefaultRows { get; set; } = 30;
    public string DefaultWorkingDirectory { get; set; } = "";

    private static ShellType GetPlatformDefaultShell()
    {
        if (OperatingSystem.IsWindows())
        {
            return ShellType.Pwsh;
        }
        if (OperatingSystem.IsMacOS())
        {
            return ShellType.Zsh;
        }
        return ShellType.Bash;
    }

    // Terminal Appearance
    public int FontSize { get; set; } = 14;
    public string FontFamily { get; set; } = "Cascadia Code";
    public CursorStyleSetting CursorStyle { get; set; } = CursorStyleSetting.Bar;
    public bool CursorBlink { get; set; } = true;
    public CursorInactiveStyleSetting CursorInactiveStyle { get; set; } = CursorInactiveStyleSetting.Outline;
    public ThemeSetting Theme { get; set; } = ThemeSetting.Dark;
    public TabTitleModeSetting TabTitleMode { get; set; } = TabTitleModeSetting.Hostname;
    public double MinimumContrastRatio { get; set; } = 1;
    public bool SmoothScrolling { get; set; } = false;
    public bool UseWebGL { get; set; } = true;

    // Terminal Behavior
    public int ScrollbackLines { get; set; } = 10000;
    public BellStyleSetting BellStyle { get; set; } = BellStyleSetting.Notification;
    public bool CopyOnSelect { get; set; } = false;
    public bool RightClickPaste { get; set; } = true;
    public ClipboardShortcutsSetting ClipboardShortcuts { get; set; } = ClipboardShortcutsSetting.Auto;
    public bool ScrollbackProtection { get; set; } = false;

    // File Radar - Detects file paths in terminal output and makes them clickable
    public bool FileRadar { get; set; } = true;

    // Security - User to spawn terminals as (when running as service)
    public string? RunAsUser { get; set; }
    public string? RunAsUserSid { get; set; }  // Windows: User SID for token lookup

    // Authentication
    public bool AuthenticationEnabled { get; set; } = false;

    [JsonIgnore]
    public string? PasswordHash { get; set; }

    [JsonIgnore]
    public string? SessionSecret { get; set; }

    // HTTPS (always enabled - no HTTP endpoint)
    public string? CertificatePath { get; set; }

    [JsonIgnore]
    public string? CertificatePassword { get; set; }  // Deprecated: for legacy PFX migration only

    public KeyProtectionMethod KeyProtection { get; set; } = KeyProtectionMethod.OsProtected;

    // Certificate thumbprint - saved after generation for verification
    // Used to detect if cert was silently regenerated during update failures
    public string? CertificateThumbprint { get; set; }

    // Service mode flag - persisted to ensure DPAPI scope is consistent between
    // installer (which runs elevated) and runtime (which runs as service user).
    // Without this, runtime detection of IsSystem can fail for non-LocalSystem services.
    public bool IsServiceInstall { get; set; } = false;

    // Diagnostics
    public LogSeverity LogLevel { get; set; } = LogSeverity.Warn;

    // Update channel: "stable" (default) or "dev" (prereleases)
    public string UpdateChannel { get; set; } = "stable";

    // Voice server password (shared secret for MidTerm.Voice authentication)
    [JsonIgnore]
    public string? VoiceServerPassword { get; set; }
}
