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
    public CursorStyleSetting CursorStyle { get; set; } = CursorStyleSetting.Block;
    public bool CursorBlink { get; set; } = true;
    public CursorInactiveStyleSetting CursorInactiveStyle { get; set; } = CursorInactiveStyleSetting.None;
    public bool HideCursorOnInputBursts { get; set; } = false;
    public ThemeSetting Theme { get; set; } = ThemeSetting.Dark;
    public TerminalColorSchemeSetting TerminalColorScheme { get; set; } = TerminalColorSchemeSetting.Auto;
    public bool BackgroundImageEnabled { get; set; } = false;
    public string? BackgroundImageFileName { get; set; }
    public long BackgroundImageRevision { get; set; } = 0;
    public string BackgroundImageFit { get; set; } = "cover";
    public int UiTransparency { get; set; } = 0;
    public TabTitleModeSetting TabTitleMode { get; set; } = TabTitleModeSetting.Hostname;
    public double MinimumContrastRatio { get; set; } = 1;
    public bool SmoothScrolling { get; set; } = false;
    public ScrollbarStyleSetting ScrollbarStyle { get; set; } = ScrollbarStyleSetting.Off;
    public bool UseWebGL { get; set; } = true;

    // Terminal Behavior
    public int ScrollbackLines { get; set; } = 10000;
    public BellStyleSetting BellStyle { get; set; } = BellStyleSetting.Notification;
    public bool CopyOnSelect { get; set; } = false;
    public bool RightClickPaste { get; set; } = true;
    public ClipboardShortcutsSetting ClipboardShortcuts { get; set; } = ClipboardShortcutsSetting.Auto;
    public TerminalEnterModeSetting TerminalEnterMode { get; set; } = TerminalEnterModeSetting.Default;
    public bool ScrollbackProtection { get; set; } = false;
    public string InputMode { get; set; } = "keyboard";
    public bool FileRadar { get; set; } = true;
    public bool TmuxCompatibility { get; set; } = true;
    public bool IdeMode { get; set; } = true;
    public bool ManagerBarEnabled { get; set; } = true;
    public bool DevMode { get; set; } = false;
    public bool ShowChangelogAfterUpdate { get; set; } = true;
    public bool ShowUpdateNotification { get; set; } = true;
    public string UpdateChannel { get; set; } = "stable";
    public LanguageSetting Language { get; set; } = LanguageSetting.Auto;
    public List<ManagerBarButton> ManagerBarButtons { get; set; } = [new() { Id = "1", Label = "commit and push pls", Text = "commit and push pls" }];

    // Security
    public string? RunAsUser { get; set; }
    public string? RunAsUserSid { get; set; }

    // Authentication
    public bool AuthenticationEnabled { get; set; } = false;

    // HTTPS
    public string? CertificatePath { get; set; }
}
