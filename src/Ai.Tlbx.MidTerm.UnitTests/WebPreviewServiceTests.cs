using Ai.Tlbx.MidTerm.Services.WebPreview;
using Ai.Tlbx.MidTerm.Services.Browser;
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

    [Fact]
    public void SetTarget_SelfTargetWithPreviewOriginEnabled_AllowsMidTermInMidTerm()
    {
        var previewOrigin = new BrowserPreviewOriginService(mainPort: 2000, previewPort: 2001, isEnabled: true);
        var service = new WebPreviewService(serverPort: 2000, previewOriginService: previewOrigin);

        var ok = service.SetTarget("https://localhost:2000");

        Assert.True(ok);
        Assert.Equal("https://localhost:2000/", service.TargetUrl);
    }

    [Fact]
    public void SetTarget_SelfTargetWithoutPreviewOrigin_RemainsBlocked()
    {
        var service = new WebPreviewService(serverPort: 2000);

        var ok = service.SetTarget("https://localhost:2000");

        Assert.False(ok);
    }

    [Fact]
    public void SyncSessionCookieForSelfTarget_DoesNotExposeAuthCookieToBrowser()
    {
        var previewOrigin = new BrowserPreviewOriginService(mainPort: 2000, previewPort: 2001, isEnabled: true);
        var service = new WebPreviewService(serverPort: 2000, previewOriginService: previewOrigin);
        Assert.True(service.SetTarget("https://localhost:2000"));

        service.SyncSessionCookieForSelfTarget("token-123");

        var allCookies = service.GetCookies();
        var browserCookies = service.GetBrowserCookies(new Uri("https://localhost:2000/"));

        Assert.Contains(allCookies.Cookies, cookie => cookie.Name == "mm-session" && cookie.HttpOnly);
        Assert.DoesNotContain("mm-session=token-123", browserCookies.Header ?? "", StringComparison.Ordinal);
    }

    [Fact]
    public void PersistCookies_SelfTargetSkipsAuthCookieOnDisk()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "midterm-webpreview-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);

        try
        {
            var previewOrigin = new BrowserPreviewOriginService(mainPort: 2000, previewPort: 2001, isEnabled: true);
            var service = new WebPreviewService(serverPort: 2000, previewOriginService: previewOrigin, cookiesDirectory: tempDir);
            Assert.True(service.SetTarget("https://localhost:2000"));
            Assert.True(service.SetCookieFromRaw("theme=dark; Path=/"));
            service.SyncSessionCookieForSelfTarget("token-123");
            service.PersistCookies();

            var reloaded = new WebPreviewService(serverPort: 2000, previewOriginService: previewOrigin, cookiesDirectory: tempDir);
            Assert.True(reloaded.SetTarget("https://localhost:2000"));

            var cookies = reloaded.GetCookies();

            Assert.Contains("theme=dark", cookies.Header ?? "", StringComparison.Ordinal);
            Assert.DoesNotContain("mm-session=token-123", cookies.Header ?? "", StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }
}
