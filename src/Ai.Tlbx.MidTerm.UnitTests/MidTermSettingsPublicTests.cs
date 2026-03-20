using Ai.Tlbx.MidTerm.Models.Hub;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MidTermSettingsPublicTests
{
    [Fact]
    public void FromSettings_AndApplyTo_RoundTripTerminalTransparency()
    {
        var settings = new MidTermSettings
        {
            UiTransparency = 25,
            TerminalTransparency = 55
        };

        var publicSettings = MidTermSettingsPublic.FromSettings(settings);

        Assert.Equal(55, publicSettings.TerminalTransparency);

        settings.TerminalTransparency = 0;
        publicSettings.ApplyTo(settings);

        Assert.Equal(55, settings.TerminalTransparency);
    }

    [Fact]
    public void ApplyTo_NullTerminalTransparency_PreservesExistingValue()
    {
        var settings = new MidTermSettings
        {
            UiTransparency = 10,
            TerminalTransparency = 45
        };

        var publicSettings = new MidTermSettingsPublic
        {
            UiTransparency = 10,
            TerminalTransparency = null
        };

        publicSettings.ApplyTo(settings);

        Assert.Equal(45, settings.TerminalTransparency);
    }

    [Fact]
    public void FromSettings_AndApplyTo_RoundTripFontRenderingSettings()
    {
        var settings = new MidTermSettings
        {
            LineHeight = 1.2,
            LetterSpacing = 0.4,
            FontWeight = "500",
            FontWeightBold = "700"
        };

        var publicSettings = MidTermSettingsPublic.FromSettings(settings);

        Assert.Equal(1.2, publicSettings.LineHeight);
        Assert.Equal(0.4, publicSettings.LetterSpacing);
        Assert.Equal("500", publicSettings.FontWeight);
        Assert.Equal("700", publicSettings.FontWeightBold);

        settings.LineHeight = 1;
        settings.LetterSpacing = 0;
        settings.FontWeight = "normal";
        settings.FontWeightBold = "bold";
        publicSettings.ApplyTo(settings);

        Assert.Equal(1.2, settings.LineHeight);
        Assert.Equal(0.4, settings.LetterSpacing);
        Assert.Equal("500", settings.FontWeight);
        Assert.Equal("700", settings.FontWeightBold);
    }

    [Fact]
    public void ApplyTo_ClampsAndValidatesFontRenderingSettings()
    {
        var settings = new MidTermSettings
        {
            LineHeight = 1,
            LetterSpacing = 0,
            FontWeight = "normal",
            FontWeightBold = "bold"
        };

        var publicSettings = new MidTermSettingsPublic
        {
            LineHeight = 5,
            LetterSpacing = -10,
            FontWeight = "invalid",
            FontWeightBold = "900"
        };

        publicSettings.ApplyTo(settings);

        Assert.Equal(3, settings.LineHeight);
        Assert.Equal(-2, settings.LetterSpacing);
        Assert.Equal("normal", settings.FontWeight);
        Assert.Equal("900", settings.FontWeightBold);
    }

    [Fact]
    public void FromSettings_ProjectsHubMachinesWithoutExposingSecrets()
    {
        var settings = new MidTermSettings
        {
            HubMachines =
            [
                new HubMachineSettings
                {
                    Id = "machine-a",
                    Name = "Server",
                    BaseUrl = "https://server:8443",
                    Enabled = true,
                    ApiKey = "api-secret",
                    Password = "pw-secret",
                    LastFingerprint = "AA:BB",
                    PinnedFingerprint = "CC:DD"
                }
            ]
        };

        var publicSettings = MidTermSettingsPublic.FromSettings(settings);

        var machine = Assert.Single(publicSettings.HubMachines);
        Assert.Equal("machine-a", machine.Id);
        Assert.True(machine.HasApiKey);
        Assert.True(machine.HasPassword);
        Assert.Equal("AA:BB", machine.LastFingerprint);
        Assert.Equal("CC:DD", machine.PinnedFingerprint);
    }

    [Fact]
    public void ApplyTo_DoesNotReplaceExistingHubMachineSecrets()
    {
        var settings = new MidTermSettings
        {
            HubMachines =
            [
                new HubMachineSettings
                {
                    Id = "machine-a",
                    Name = "Existing",
                    BaseUrl = "https://server:8443",
                    ApiKey = "api-secret",
                    Password = "pw-secret"
                }
            ]
        };

        var publicSettings = new MidTermSettingsPublic
        {
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
            Language = settings.Language
        };

        publicSettings.ApplyTo(settings);

        var machine = Assert.Single(settings.HubMachines);
        Assert.Equal("api-secret", machine.ApiKey);
        Assert.Equal("pw-secret", machine.Password);
    }
}
