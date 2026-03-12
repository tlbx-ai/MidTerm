using Ai.Tlbx.MidTerm.Startup;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class AuthMiddlewareTests
{
    [Theory]
    [InlineData("/swagger")]
    [InlineData("/swagger/index.html")]
    [InlineData("/swagger/swagger-ui.css")]
    [InlineData("/swagger/swagger-ui-bundle.js")]
    [InlineData("/openapi/openapi.json")]
    public void IsPublicPath_DiscoverabilityAssets_ArePublic(string path)
    {
        Assert.True(AuthMiddleware.IsPublicPath(path));
    }

    [Theory]
    [InlineData("/api/state")]
    [InlineData("/api/system")]
    [InlineData("/api/sessions/abc/state")]
    [InlineData("/api/browser/status")]
    [InlineData("/ws/state")]
    public void IsPublicPath_RemoteControlEndpoints_RemainProtected(string path)
    {
        Assert.False(AuthMiddleware.IsPublicPath(path));
    }
}
