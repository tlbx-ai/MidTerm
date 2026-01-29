using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Shells;

namespace Ai.Tlbx.MidTerm.Settings;

public sealed partial class MidTermSettingsPublic
{
    // Session Defaults (DefaultShell intentionally nullable - platform-specific logic at runtime)
    public ShellType? DefaultShell { get; set; }
    public int DefaultCols { get; set; } = 120;
    public int DefaultRows { get; set; } = 30;
    public string DefaultWorkingDirectory { get; set; } = "";

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
    public bool FileRadar { get; set; } = true;

    // Security
    public string? RunAsUser { get; set; }
    public string? RunAsUserSid { get; set; }

    // Authentication
    public bool AuthenticationEnabled { get; set; } = false;

    // HTTPS
    public string? CertificatePath { get; set; }

    // Diagnostics
    public LogSeverity LogLevel { get; set; } = LogSeverity.Warn;
}
