using Ai.Tlbx.MidTerm.Services;

namespace Ai.Tlbx.MidTerm.Settings;

public sealed partial class MidTermSettingsPublic
{
    private static readonly HashSet<string> ValidFontWeights =
    [
        "100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold"
    ];

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
            LineHeight = settings.LineHeight,
            LetterSpacing = settings.LetterSpacing,
            FontWeight = settings.FontWeight,
            FontWeightBold = settings.FontWeightBold,
            CursorStyle = settings.CursorStyle,
            CursorBlink = settings.CursorBlink,
            CursorInactiveStyle = settings.CursorInactiveStyle,
            HideCursorOnInputBursts = settings.HideCursorOnInputBursts,
            Theme = settings.Theme,
            TerminalColorScheme = settings.TerminalColorScheme,
            BackgroundImageEnabled = settings.BackgroundImageEnabled,
            BackgroundImageFileName = settings.BackgroundImageFileName,
            BackgroundImageRevision = settings.BackgroundImageRevision,
            BackgroundImageFit = settings.BackgroundImageFit,
            UiTransparency = settings.UiTransparency,
            TerminalTransparency = settings.TerminalTransparency,
            TabTitleMode = settings.TabTitleMode,
            MinimumContrastRatio = settings.MinimumContrastRatio,
            SmoothScrolling = settings.SmoothScrolling,
            ScrollbarStyle = settings.ScrollbarStyle,
            UseWebGL = settings.UseWebGL,
            ScrollbackLines = settings.ScrollbackLines,
            BellStyle = settings.BellStyle,
            CopyOnSelect = settings.CopyOnSelect,
            RightClickPaste = settings.RightClickPaste,
            ClipboardShortcuts = settings.ClipboardShortcuts,
            TerminalEnterMode = settings.TerminalEnterMode,
            ScrollbackProtection = settings.ScrollbackProtection,
            KeepSystemAwakeWithActiveSessions = settings.KeepSystemAwakeWithActiveSessions,
            InputMode = settings.InputMode,
            FileRadar = settings.FileRadar,
            ShowSidebarSessionFilter = settings.ShowSidebarSessionFilter,
            TmuxCompatibility = settings.TmuxCompatibility,
            ManagerBarEnabled = settings.ManagerBarEnabled,
            ManagerBarButtons = settings.ManagerBarButtons,
            DevMode = settings.DevMode,
            ShowChangelogAfterUpdate = settings.ShowChangelogAfterUpdate,
            ShowUpdateNotification = settings.ShowUpdateNotification,
            UpdateChannel = settings.UpdateChannel,
            Language = settings.Language,
            RunAsUser = settings.RunAsUser,
            RunAsUserSid = settings.RunAsUserSid,
            AuthenticationEnabled = settings.AuthenticationEnabled,
            CertificatePath = settings.CertificatePath
        };
    }

    public void ApplyTo(MidTermSettings settings)
    {
        if (DefaultShell.HasValue) settings.DefaultShell = DefaultShell.Value;
        settings.DefaultCols = DefaultCols;
        settings.DefaultRows = DefaultRows;
        settings.DefaultWorkingDirectory = DefaultWorkingDirectory;
        settings.FontSize = FontSize;
        settings.FontFamily = FontFamily;
        settings.LineHeight = Math.Clamp(LineHeight, 0.8, 3.0);
        settings.LetterSpacing = Math.Clamp(LetterSpacing, -2.0, 10.0);
        if (ValidFontWeights.Contains(FontWeight))
        {
            settings.FontWeight = FontWeight;
        }
        if (ValidFontWeights.Contains(FontWeightBold))
        {
            settings.FontWeightBold = FontWeightBold;
        }
        settings.CursorStyle = CursorStyle;
        settings.CursorBlink = CursorBlink;
        settings.CursorInactiveStyle = CursorInactiveStyle;
        settings.HideCursorOnInputBursts = HideCursorOnInputBursts;
        settings.Theme = Theme;
        settings.TerminalColorScheme = TerminalColorScheme;
        settings.BackgroundImageEnabled = BackgroundImageEnabled;
        if (BackgroundImageFit is "cover" or "contain")
        {
            settings.BackgroundImageFit = BackgroundImageFit;
        }
        settings.UiTransparency = Math.Clamp(UiTransparency, 0, 85);
        if (TerminalTransparency.HasValue)
        {
            settings.TerminalTransparency = Math.Clamp(TerminalTransparency.Value, 0, 85);
        }
        settings.TabTitleMode = TabTitleMode;
        settings.MinimumContrastRatio = MinimumContrastRatio;
        settings.SmoothScrolling = SmoothScrolling;
        settings.ScrollbarStyle = ScrollbarStyle;
        settings.UseWebGL = UseWebGL;
        settings.ScrollbackLines = ScrollbackLines;
        settings.BellStyle = BellStyle;
        settings.CopyOnSelect = CopyOnSelect;
        settings.RightClickPaste = RightClickPaste;
        settings.ClipboardShortcuts = ClipboardShortcuts;
        settings.TerminalEnterMode = TerminalEnterMode;
        settings.ScrollbackProtection = ScrollbackProtection;
        settings.KeepSystemAwakeWithActiveSessions = KeepSystemAwakeWithActiveSessions;
        if (InputMode is "keyboard" or "smartinput" or "both")
            settings.InputMode = InputMode;
        settings.FileRadar = FileRadar;
        settings.ShowSidebarSessionFilter = ShowSidebarSessionFilter;
        settings.TmuxCompatibility = TmuxCompatibility;
        settings.ManagerBarEnabled = ManagerBarEnabled;
        settings.ManagerBarButtons = ManagerBarButtons;
        settings.DevMode = DevMode;
        settings.ShowChangelogAfterUpdate = ShowChangelogAfterUpdate;
        settings.ShowUpdateNotification = ShowUpdateNotification;
        if (UpdateChannel is "stable" or "dev")
            settings.UpdateChannel = UpdateChannel;
        settings.Language = Language;

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

        // RunAsUserSid is derived server-side from RunAsUser (Windows only)
        // AuthenticationEnabled is managed by the auth endpoint
        // CertificatePath is set via install/CLI
        // Background image metadata is managed by the background image endpoints
        // These fields are read-only in the GET response and ignored on PUT.
    }
}
