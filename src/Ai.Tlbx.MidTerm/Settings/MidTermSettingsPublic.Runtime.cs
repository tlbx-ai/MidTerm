using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Models.Hub;

namespace Ai.Tlbx.MidTerm.Settings;

public sealed partial class MidTermSettingsPublic
{
    private static readonly HashSet<string> ValidFontWeights =
    [
        "100", "200", "300", "400", "500", "600", "700", "800", "900", "normal", "bold"
    ];
    private static readonly HashSet<string> BuiltInTerminalColorSchemeNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "auto",
        "dark",
        "light",
        "macTerminalDark",
        "macTerminalLight",
        "solarizedDark",
        "solarizedLight",
        "matrix"
    };

    public static MidTermSettingsPublic FromSettings(MidTermSettings settings)
    {
        var terminalColorSchemes = NormalizeTerminalColorSchemes(settings.TerminalColorSchemes);
        var terminalColorScheme = NormalizeTerminalColorSchemeName(settings.TerminalColorScheme);
        return new MidTermSettingsPublic
        {
            DefaultShell = settings.DefaultShell,
            DefaultCols = settings.DefaultCols,
            DefaultRows = settings.DefaultRows,
            DefaultWorkingDirectory = settings.DefaultWorkingDirectory,
            CodexYoloDefault = settings.CodexYoloDefault,
            CodexEnvironmentVariables = settings.CodexEnvironmentVariables,
            ClaudeDangerouslySkipPermissionsDefault = settings.ClaudeDangerouslySkipPermissionsDefault,
            ClaudeEnvironmentVariables = settings.ClaudeEnvironmentVariables,
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
            TerminalColorScheme = IsKnownTerminalColorScheme(terminalColorScheme, terminalColorSchemes)
                ? terminalColorScheme
                : "auto",
            TerminalColorSchemes = terminalColorSchemes,
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
            ManagerBarButtons = ManagerBarButton.NormalizeList(settings.ManagerBarButtons),
            DevMode = settings.DevMode,
            ShowChangelogAfterUpdate = settings.ShowChangelogAfterUpdate,
            ShowUpdateNotification = settings.ShowUpdateNotification,
            UpdateChannel = settings.UpdateChannel,
            Language = settings.Language,
            RunAsUser = settings.RunAsUser,
            RunAsUserSid = settings.RunAsUserSid,
            AuthenticationEnabled = settings.AuthenticationEnabled,
            CertificatePath = settings.CertificatePath,
            HubMachines = settings.HubMachines
                .Select(machine => new HubMachineInfo
                {
                    Id = machine.Id,
                    Name = machine.Name,
                    BaseUrl = machine.BaseUrl,
                    Enabled = machine.Enabled,
                    HasApiKey = !string.IsNullOrWhiteSpace(machine.ApiKey),
                    HasPassword = !string.IsNullOrWhiteSpace(machine.Password),
                    LastFingerprint = machine.LastFingerprint,
                    PinnedFingerprint = machine.PinnedFingerprint
                })
                .ToList()
        };
    }

    public void ApplyTo(MidTermSettings settings)
    {
        if (DefaultShell.HasValue) settings.DefaultShell = DefaultShell.Value;
        settings.DefaultCols = DefaultCols;
        settings.DefaultRows = DefaultRows;
        settings.DefaultWorkingDirectory = DefaultWorkingDirectory;
        settings.CodexYoloDefault = CodexYoloDefault;
        settings.CodexEnvironmentVariables = CodexEnvironmentVariables ?? string.Empty;
        settings.ClaudeDangerouslySkipPermissionsDefault = ClaudeDangerouslySkipPermissionsDefault;
        settings.ClaudeEnvironmentVariables = ClaudeEnvironmentVariables ?? string.Empty;
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
        var terminalColorSchemes = NormalizeTerminalColorSchemes(TerminalColorSchemes);
        settings.TerminalColorSchemes = terminalColorSchemes;
        var terminalColorScheme = NormalizeTerminalColorSchemeName(TerminalColorScheme);
        settings.TerminalColorScheme = IsKnownTerminalColorScheme(terminalColorScheme, terminalColorSchemes)
            ? terminalColorScheme
            : "auto";
        settings.BackgroundImageEnabled = BackgroundImageEnabled;
        if (BackgroundImageFit is "cover" or "contain")
        {
            settings.BackgroundImageFit = BackgroundImageFit;
        }
        settings.UiTransparency = Math.Clamp(UiTransparency, 0, 100);
        if (TerminalTransparency.HasValue)
        {
            settings.TerminalTransparency = Math.Clamp(TerminalTransparency.Value, 0, 100);
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
        settings.ManagerBarButtons = ManagerBarButton.NormalizeList(ManagerBarButtons);
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
        // Hub machine configuration is managed by the hub endpoints so credentials are not lost
        // These fields are read-only in the GET response and ignored on PUT.
    }

    private static string NormalizeTerminalColorSchemeName(string? value)
    {
        return string.IsNullOrWhiteSpace(value) ? "auto" : value.Trim();
    }

    private static bool IsKnownTerminalColorScheme(
        string value,
        IReadOnlyCollection<TerminalColorSchemeDefinition> customSchemes)
    {
        if (BuiltInTerminalColorSchemeNames.Contains(value))
        {
            return true;
        }

        return customSchemes.Any(
            scheme => string.Equals(scheme.Name, value, StringComparison.OrdinalIgnoreCase));
    }

    private static List<TerminalColorSchemeDefinition> NormalizeTerminalColorSchemes(
        IEnumerable<TerminalColorSchemeDefinition>? terminalColorSchemes)
    {
        var normalized = new List<TerminalColorSchemeDefinition>();
        var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var scheme in terminalColorSchemes ?? [])
        {
            var entry = TerminalColorSchemeDefinition.Normalize(scheme);
            if (entry is null)
            {
                continue;
            }

            if (BuiltInTerminalColorSchemeNames.Contains(entry.Name))
            {
                continue;
            }

            if (!seenNames.Add(entry.Name))
            {
                continue;
            }

            normalized.Add(entry);
        }

        return normalized;
    }
}
