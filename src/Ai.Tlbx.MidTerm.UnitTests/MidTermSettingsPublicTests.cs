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
}
