using Ai.Tlbx.MidTerm.Services.WebPreview;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class WebPreviewServiceTests
{
    [Fact]
    public void SetTarget_PathWithTrailingSlash_PreservesTrailingSlash()
    {
        var service = new WebPreviewService(serverPort: 2000);

        var ok = service.SetTarget("https://example.com/coaching/plans/");

        Assert.True(ok);
        Assert.NotNull(service.TargetUri);
        Assert.Equal("/coaching/plans/", service.TargetUri!.AbsolutePath);
    }

    [Fact]
    public void GetBrowserCookies_ExcludesHttpOnlyCookies()
    {
        var service = new WebPreviewService(serverPort: 2000);
        Assert.True(service.SetTarget("https://example.com"));
        Assert.True(service.SetCookieFromRaw("theme=dark; Path=/"));
        Assert.True(service.SetCookieFromRaw("session=abc123; Path=/; HttpOnly"));

        var browserCookies = service.GetBrowserCookies(new Uri("https://example.com/"));
        var allCookies = service.GetCookies();

        Assert.Contains("theme=dark", browserCookies.Header, StringComparison.Ordinal);
        Assert.DoesNotContain("session=abc123", browserCookies.Header, StringComparison.Ordinal);
        Assert.Contains(allCookies.Cookies, cookie => cookie.Name == "session" && cookie.HttpOnly);
    }

    [Fact]
    public void SetTarget_DifferentPort_ResetsCookieJar()
    {
        var service = new WebPreviewService(serverPort: 2000);
        Assert.True(service.SetTarget("https://example.com:3000"));
        Assert.True(service.SetCookieFromRaw("theme=dark; Path=/"));

        Assert.True(service.SetTarget("https://example.com:4000"));

        var cookies = service.GetCookies();
        Assert.True(string.IsNullOrEmpty(cookies.Header));
        Assert.Empty(cookies.Cookies);
    }
}
