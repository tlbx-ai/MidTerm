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
}
