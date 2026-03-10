using Ai.Tlbx.MidTerm.Services.WebPreview;
using Ai.Tlbx.MidTerm.Services.Browser;
using Microsoft.AspNetCore.Http;
using System.Reflection;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class WebPreviewProxyMiddlewareTests
{
    [Fact]
    public void BuildUpstreamPath_TargetWithBaseAndRootPath_ReturnsTargetBase()
    {
        var target = new Uri("https://example.com/dashboard");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/");

        Assert.Equal("/dashboard", result);
    }

    [Fact]
    public void BuildUpstreamPath_RequestAlreadyContainsTargetBase_DoesNotDuplicate()
    {
        var target = new Uri("https://example.com/dashboard");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/dashboard/lib/sneat/css/core.css");

        Assert.Equal("/dashboard/lib/sneat/css/core.css", result);
    }

    [Fact]
    public void BuildUpstreamPath_RequestOutsideTargetBase_PrependsTargetBase()
    {
        var target = new Uri("https://example.com/dashboard");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/api/health");

        Assert.Equal("/dashboard/api/health", result);
    }

    [Fact]
    public void BuildUpstreamPath_TargetWithoutBasePath_UsesRequestPath()
    {
        var target = new Uri("https://example.com/");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/css/app.css");

        Assert.Equal("/css/app.css", result);
    }

    [Fact]
    public void BuildUpstreamPath_TargetWithTrailingSlashAndRootPath_PreservesTrailingSlash()
    {
        var target = new Uri("https://example.com/dashboard/");

        var result = WebPreviewProxyMiddleware.BuildUpstreamPath(target, "/");

        Assert.Equal("/dashboard/", result);
    }

    [Fact]
    public async Task InvokeAsync_InternalSelfProxyRequest_BypassesCatchAllLoop()
    {
        var previewOrigin = new BrowserPreviewOriginService(mainPort: 2000, previewPort: 2001, isEnabled: true);
        var service = new WebPreviewService(serverPort: 2000, previewOriginService: previewOrigin);
        Assert.True(service.SetTarget("https://localhost:2000/"));

        var nextCalled = false;
        var middleware = new WebPreviewProxyMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }, service);

        var context = new DefaultHttpContext();
        context.Request.Path = "/site.webmanifest";
        context.Request.Headers["X-MidTerm-Internal-Proxy"] = "1";

        await middleware.InvokeAsync(context);

        Assert.True(nextCalled);
    }

    [Fact]
    public void UrlRewriteScript_RequestFetchRewrite_PreservesRequestBodies()
    {
        var field = typeof(WebPreviewProxyMiddleware).GetField(
            "UrlRewriteScript",
            BindingFlags.NonPublic | BindingFlags.Static);

        var script = Assert.IsType<string>(field?.GetRawConstantValue());

        Assert.Contains("function rfq(self,q,o)", script, StringComparison.Ordinal);
        Assert.Contains("return q.clone().arrayBuffer().then(function(body){", script, StringComparison.Ordinal);
        Assert.DoesNotContain("new Request(r(u.url),u)", script, StringComparison.Ordinal);
    }

    [Fact]
    public void CollectProxyPathPrefixes_RewrittenHtml_PrimesServerRootAssetPrefixes()
    {
        const string html = """
            <link rel="stylesheet" href="/webpreview/_astro/DocsStatic.css">
            <script type="module" src="/webpreview/_astro/page.js"></script>
            <img src="/webpreview/OpenAI_Developers.svg">
            <a href="/webpreview/api/reference/resources/audio/index.md">Markdown</a>
            <style>
              @font-face { src: url(/webpreview/_astro/fonts/site.woff2); }
              .hero { background-image: url('/webpreview/img/logo.png'); }
            </style>
            <a href="/webpreview/_ext?u=https%3A%2F%2Fcdn.openai.com%2Ffont.woff2">External</a>
            """;

        var prefixes = WebPreviewProxyMiddleware.CollectProxyPathPrefixes(html);

        Assert.Equal(
            new[]
            {
                "/api/",
                "/img/",
                "/OpenAI_Developers.svg/",
                "/_astro/"
            },
            prefixes);
    }
}
