using Ai.Tlbx.MidTerm.Common.Shells;
using Ai.Tlbx.MidTerm.Services;

namespace Ai.Tlbx.MidTerm.Settings;

public sealed class MidTermSettingsPublic
{
    // Session Defaults
    public ShellType DefaultShell { get; set; }
    public int DefaultCols { get; set; }
    public int DefaultRows { get; set; }
    public string DefaultWorkingDirectory { get; set; } = "";

    // Terminal Appearance
    public int FontSize { get; set; }
    public string FontFamily { get; set; } = "";
    public CursorStyleSetting CursorStyle { get; set; }
    public bool CursorBlink { get; set; }
    public ThemeSetting Theme { get; set; }
    public TabTitleModeSetting TabTitleMode { get; set; }
    public double MinimumContrastRatio { get; set; }
    public bool SmoothScrolling { get; set; }
    public bool UseWebGL { get; set; }

    // Terminal Behavior
    public int ScrollbackLines { get; set; }
    public BellStyleSetting BellStyle { get; set; }
    public bool CopyOnSelect { get; set; }
    public bool RightClickPaste { get; set; }
    public ClipboardShortcutsSetting ClipboardShortcuts { get; set; }
    public bool ScrollbackProtection { get; set; }
    public bool FileRadar { get; set; }

    // Security - User to spawn terminals as (when running as service)
    public string? RunAsUser { get; set; }
    public string? RunAsUserSid { get; set; }

    // Authentication (public fields only - no PasswordHash, SessionSecret)
    public bool AuthenticationEnabled { get; set; }

    // HTTPS (always enabled - no CertificatePassword exposed)
    public string? CertificatePath { get; set; }

    public static MidTermSettingsPublic FromSettings(MidTermSettings settings)
    {
        return new MidTermSettingsPublic
        {
            DefaultShell = settings.DefaultShell,
            DefaultCols = settings.DefaultCols,
            DefaultRows = settings.DefaultRows,
            DefaultWorkingDirectory = settings.DefaultWorkingDirectory,
            FontSize = settings.FontSize,
            FontFamily = settings.FontFamily,
            CursorStyle = settings.CursorStyle,
            CursorBlink = settings.CursorBlink,
            Theme = settings.Theme,
            TabTitleMode = settings.TabTitleMode,
            MinimumContrastRatio = settings.MinimumContrastRatio,
            SmoothScrolling = settings.SmoothScrolling,
            UseWebGL = settings.UseWebGL,
            ScrollbackLines = settings.ScrollbackLines,
            BellStyle = settings.BellStyle,
            CopyOnSelect = settings.CopyOnSelect,
            RightClickPaste = settings.RightClickPaste,
            ClipboardShortcuts = settings.ClipboardShortcuts,
            ScrollbackProtection = settings.ScrollbackProtection,
            FileRadar = settings.FileRadar,
            RunAsUser = settings.RunAsUser,
            RunAsUserSid = settings.RunAsUserSid,
            AuthenticationEnabled = settings.AuthenticationEnabled,
            CertificatePath = settings.CertificatePath
        };
    }

    public void ApplyTo(MidTermSettings settings)
    {
        settings.DefaultShell = DefaultShell;
        settings.DefaultCols = DefaultCols;
        settings.DefaultRows = DefaultRows;
        settings.DefaultWorkingDirectory = DefaultWorkingDirectory;
        settings.FontSize = FontSize;
        settings.FontFamily = FontFamily;
        settings.CursorStyle = CursorStyle;
        settings.CursorBlink = CursorBlink;
        settings.Theme = Theme;
        settings.TabTitleMode = TabTitleMode;
        settings.MinimumContrastRatio = MinimumContrastRatio;
        settings.SmoothScrolling = SmoothScrolling;
        settings.UseWebGL = UseWebGL;
        settings.ScrollbackLines = ScrollbackLines;
        settings.BellStyle = BellStyle;
        settings.CopyOnSelect = CopyOnSelect;
        settings.RightClickPaste = RightClickPaste;
        settings.ClipboardShortcuts = ClipboardShortcuts;
        settings.ScrollbackProtection = ScrollbackProtection;
        settings.FileRadar = FileRadar;

        // SECURITY: Validate RunAsUser before applying
        if (!OperatingSystem.IsWindows())
        {
            var (isValid, error) = UserValidationService.ValidateRunAsUser(RunAsUser);
            if (!isValid)
            {
                throw new ArgumentException(error);
            }
        }
        settings.RunAsUser = RunAsUser;

        // SECURITY: Validate Windows SID format
        if (OperatingSystem.IsWindows() && !UserValidationService.IsValidWindowsSid(RunAsUserSid))
        {
            throw new ArgumentException($"Invalid Windows SID format: {RunAsUserSid}");
        }
        settings.RunAsUserSid = RunAsUserSid;

        settings.AuthenticationEnabled = AuthenticationEnabled;
        settings.CertificatePath = CertificatePath;
    }
}
