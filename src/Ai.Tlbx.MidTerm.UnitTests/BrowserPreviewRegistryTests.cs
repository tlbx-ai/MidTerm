using Ai.Tlbx.MidTerm.Services.Browser;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class BrowserPreviewRegistryTests
{
    [Fact]
    public void Create_AndValidate_RoundTripsSessionIdentity()
    {
        var registry = new BrowserPreviewRegistry();

        var created = registry.Create("session-1");

        var ok = registry.TryValidate(created.PreviewId, created.PreviewToken, out var validated);

        Assert.True(ok);
        Assert.NotNull(validated);
        Assert.Equal("session-1", validated!.SessionId);
        Assert.Equal(created.PreviewId, validated.PreviewId);
        Assert.Equal(created.PreviewToken, validated.PreviewToken);
    }

    [Fact]
    public void TryValidate_WithWrongToken_Fails()
    {
        var registry = new BrowserPreviewRegistry();
        var created = registry.Create("session-1");

        var ok = registry.TryValidate(created.PreviewId, "wrong-token", out _);

        Assert.False(ok);
    }

    [Fact]
    public void TryValidate_RetainsBrowserIdentity()
    {
        var registry = new BrowserPreviewRegistry();
        var created = registry.Create("session-1", "browser-1");

        var ok = registry.TryValidate(created.PreviewId, created.PreviewToken, out var validated);

        Assert.True(ok);
        Assert.NotNull(validated);
        Assert.Equal("browser-1", validated!.BrowserId);
    }
}
