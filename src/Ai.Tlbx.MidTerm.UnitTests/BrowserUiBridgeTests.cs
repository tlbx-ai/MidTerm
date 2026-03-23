using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Browser;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class BrowserUiBridgeTests
{
    [Fact]
    public void RequestOpen_WithoutListeners_ReturnsHelpfulError()
    {
        var mainBrowser = new MainBrowserService();
        var bridge = new BrowserUiBridge(mainBrowser);

        var ok = bridge.RequestOpen(null, null, "https://example.com", true, out var error);

        Assert.False(ok);
        Assert.Contains("No MidTerm browser UI is connected", error, StringComparison.Ordinal);
        Assert.Contains("/ws/state", error, StringComparison.Ordinal);
    }

    [Fact]
    public void RequestOpen_PrefersMainBrowserNewestListener()
    {
        var mainBrowser = new MainBrowserService();
        var bridge = new BrowserUiBridge(mainBrowser);
        var connectionToken = new object();
        string? openedUrl = null;

        mainBrowser.Register("browser-a", connectionToken);
        mainBrowser.Claim("browser-a");

        bridge.RegisterListener("l1", "browser-b", (_, _) => { }, (_, _) => { }, (_, _, _, _) => { }, (_, _, _, _) => throw new Xunit.Sdk.XunitException("wrong listener"));
        bridge.RegisterListener("l2", "browser-a", (_, _) => { }, (_, _) => { }, (_, _, _, _) => { }, (_, _, url, _) => openedUrl = "old:" + url);
        bridge.RegisterListener("l3", "browser-a", (_, _) => { }, (_, _) => { }, (_, _, _, _) => { }, (_, _, url, _) => openedUrl = url);

        var ok = bridge.RequestOpen(null, null, "https://example.com", true, out var error);

        Assert.True(ok);
        Assert.Equal("", error);
        Assert.Equal("https://example.com", openedUrl);
    }
}
