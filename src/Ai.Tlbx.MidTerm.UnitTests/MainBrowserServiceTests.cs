using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MainBrowserServiceTests
{
    [Fact]
    public void Unregister_PreservesMainOwnershipUntilAnotherBrowserExplicitlyClaimsIt()
    {
        var service = new MainBrowserService();
        var mainConnection = new object();
        var followerConnection = new object();

        service.Register("browser-a:tab-1", mainConnection);
        service.Claim("browser-a:tab-1");
        service.Register("browser-b:tab-2", followerConnection);

        service.Unregister("browser-a:tab-1", mainConnection);

        Assert.Equal("browser-a:tab-1", service.GetMainBrowserId());
        Assert.False(service.IsMain("browser-b:tab-2"));
        Assert.True(service.ShouldShowButton("browser-b:tab-2"));

        service.Claim("browser-b:tab-2");

        Assert.Equal("browser-b:tab-2", service.GetMainBrowserId());
        Assert.True(service.IsMain("browser-b:tab-2"));
    }

    [Fact]
    public void UpdateActivity_AutoPromotesFirstActiveBrowser_AfterThreeMinutesWithoutActiveTabs()
    {
        var timeProvider = new FakeTimeProvider(DateTimeOffset.Parse("2026-03-18T10:00:00Z"));
        var service = new MainBrowserService(timeProvider);
        var mainConnection = new object();
        var followerConnection = new object();

        service.Register("browser-a:tab-1", mainConnection);
        service.UpdateActivity("browser-a:tab-1", mainConnection, true);
        service.Claim("browser-a:tab-1");

        service.UpdateActivity("browser-a:tab-1", mainConnection, false);
        timeProvider.Advance(TimeSpan.FromMinutes(3).Add(TimeSpan.FromSeconds(1)));

        service.Register("browser-b:tab-2", followerConnection);
        service.UpdateActivity("browser-b:tab-2", followerConnection, true);

        Assert.True(service.IsMain("browser-b:tab-2"));
        Assert.False(service.IsMain("browser-a:tab-1"));
    }

    [Fact]
    public void UpdateActivity_DoesNotAutoPromoteBeforeThreeMinutes()
    {
        var timeProvider = new FakeTimeProvider(DateTimeOffset.Parse("2026-03-18T10:00:00Z"));
        var service = new MainBrowserService(timeProvider);
        var mainConnection = new object();
        var followerConnection = new object();

        service.Register("browser-a:tab-1", mainConnection);
        service.UpdateActivity("browser-a:tab-1", mainConnection, true);
        service.Claim("browser-a:tab-1");

        service.UpdateActivity("browser-a:tab-1", mainConnection, false);
        timeProvider.Advance(TimeSpan.FromMinutes(2).Add(TimeSpan.FromSeconds(59)));

        service.Register("browser-b:tab-2", followerConnection);
        service.UpdateActivity("browser-b:tab-2", followerConnection, true);

        Assert.True(service.IsMain("browser-a:tab-1"));
        Assert.False(service.IsMain("browser-b:tab-2"));
    }

    [Fact]
    public void UpdateActivity_DoesNotAutoPromoteWhenDisabledInSettings()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "midterm-main-browser-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);

        try
        {
            var settingsService = new SettingsService(tempDir);
            var settings = settingsService.Load();
            settings.DisableAutoMainBrowserPromotion = true;
            settingsService.Save(settings);

            var timeProvider = new FakeTimeProvider(DateTimeOffset.Parse("2026-03-18T10:00:00Z"));
            var service = new MainBrowserService(settingsService, timeProvider);
            var mainConnection = new object();
            var followerConnection = new object();

            service.Register("browser-a:tab-1", mainConnection);
            service.UpdateActivity("browser-a:tab-1", mainConnection, true);
            service.Claim("browser-a:tab-1");

            service.UpdateActivity("browser-a:tab-1", mainConnection, false);
            timeProvider.Advance(TimeSpan.FromMinutes(3).Add(TimeSpan.FromSeconds(1)));

            service.Register("browser-b:tab-2", followerConnection);
            service.UpdateActivity("browser-b:tab-2", followerConnection, true);

            Assert.True(service.IsMain("browser-a:tab-1"));
            Assert.False(service.IsMain("browser-b:tab-2"));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }
}
