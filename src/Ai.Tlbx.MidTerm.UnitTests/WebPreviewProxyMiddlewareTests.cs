using Ai.Tlbx.MidTerm.Services.WebPreview;
using Ai.Tlbx.MidTerm.Services.Browser;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using System.Reflection;
using System.Text;
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
        Assert.True(service.SetTarget("session-1", null, "https://localhost:2000/"));

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
    public void UrlRewriteScript_CookieBridge_RefreshesAfterFetchAndXhr()
    {
        var field = typeof(WebPreviewProxyMiddleware).GetField(
            "UrlRewriteScript",
            BindingFlags.NonPublic | BindingFlags.Static);

        var script = Assert.IsType<string>(field?.GetRawConstantValue());

        Assert.Contains("function wrapCookieRefresh", script, StringComparison.Ordinal);
        Assert.Contains("XMLHttpRequest.prototype.send=function()", script, StringComparison.Ordinal);
        Assert.Contains("addEventListener(\"loadend\",onDone)", script, StringComparison.Ordinal);
        Assert.Contains("cookieRefreshTimer", script, StringComparison.Ordinal);
    }

    [Fact]
    public void UrlRewriteScript_LoadsPreviewContextFromCookieFallback()
    {
        var field = typeof(WebPreviewProxyMiddleware).GetField(
            "UrlRewriteScript",
            BindingFlags.NonPublic | BindingFlags.Static);

        var script = Assert.IsType<string>(field?.GetRawConstantValue());

        Assert.Contains("mtReadCookie(\"mt-preview-ctx\")", script, StringComparison.Ordinal);
        Assert.Contains("decodeURIComponent(mtCookieCtx)", script, StringComparison.Ordinal);
    }

    [Fact]
    public void RewriteRefererForUpstream_TargetWithBasePath_PreservesTargetBase()
    {
        var service = new WebPreviewService(serverPort: 2000);
        Assert.True(service.SetTarget("session-1", null, "https://example.com/dashboard"));
        Assert.True(service.TryGetPreviewRouteKey("session-1", null, out var routeKey));
        var middleware = new WebPreviewProxyMiddleware(_ => Task.CompletedTask, service);

        var rewritten = middleware.RewriteRefererForUpstream(
            $"https://midterm.local/webpreview/{routeKey}/api/save?draft=1",
            routeKey,
            new Uri("https://example.com/dashboard"));

        Assert.Equal("https://example.com/dashboard/api/save?draft=1", rewritten);
    }

    [Fact]
    public void RewriteRefererForUpstream_ExtProxyReferer_UsesDecodedExternalUrl()
    {
        var service = new WebPreviewService(serverPort: 2000);
        Assert.True(service.SetTarget("session-1", null, "https://example.com/dashboard"));
        Assert.True(service.TryGetPreviewRouteKey("session-1", null, out var routeKey));
        var middleware = new WebPreviewProxyMiddleware(_ => Task.CompletedTask, service);
        var externalUrl = "https://cdn.example.com/fonts/site.woff2?v=2";

        var rewritten = middleware.RewriteRefererForUpstream(
            $"https://midterm.local/webpreview/{routeKey}/_ext?u={Uri.EscapeDataString(externalUrl)}",
            routeKey,
            new Uri("https://example.com/dashboard"));

        Assert.Equal(externalUrl, rewritten);
    }

    [Fact]
    public void RewriteRefererForUpstream_NonProxyReferer_IsLeftUnchanged()
    {
        var service = new WebPreviewService(serverPort: 2000);
        var middleware = new WebPreviewProxyMiddleware(_ => Task.CompletedTask, service);
        const string referer = "https://example.net/plain/path";

        var rewritten = middleware.RewriteRefererForUpstream(
            referer,
            "route-1",
            new Uri("https://example.com/dashboard"));

        Assert.Equal(referer, rewritten);
    }

    [Fact]
    public void CollectProxyPathPrefixes_RewrittenHtml_PrimesServerRootAssetPrefixes()
    {
        const string html = """
            <link rel="stylesheet" href="/webpreview/route-1/_astro/DocsStatic.css">
            <script type="module" src="/webpreview/route-1/_astro/page.js"></script>
            <img src="/webpreview/route-1/OpenAI_Developers.svg">
            <a href="/webpreview/route-1/api/reference/resources/audio/index.md">Markdown</a>
            <style>
              @font-face { src: url(/webpreview/route-1/_astro/fonts/site.woff2); }
              .hero { background-image: url('/webpreview/route-1/img/logo.png'); }
            </style>
            <a href="/webpreview/route-1/_ext?u=https%3A%2F%2Fcdn.openai.com%2Ffont.woff2">External</a>
            """;

        var prefixes = WebPreviewProxyMiddleware.CollectProxyPathPrefixes("/webpreview/route-1", html);

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

    [Fact]
    public void RewriteRootRelativeModuleSpecifiers_RewritesInlineAndDynamicImports()
    {
        const string source = """
            <script type="module">
              import "/js/config.js";
              import login from "/js/login.js";
              export * from "/router/router-lib.js";
              const page = import("/components/PasswordInput/PasswordInput.js");
            </script>
            """;

        var rewritten = WebPreviewProxyMiddleware.RewriteRootRelativeModuleSpecifiers(
            source,
            "/webpreview/route-1");

        Assert.Contains("""import "/webpreview/route-1/js/config.js"""", rewritten, StringComparison.Ordinal);
        Assert.Contains("""import login from "/webpreview/route-1/js/login.js"""", rewritten, StringComparison.Ordinal);
        Assert.Contains("""export * from "/webpreview/route-1/router/router-lib.js"""", rewritten, StringComparison.Ordinal);
        Assert.Contains("""import("/webpreview/route-1/components/PasswordInput/PasswordInput.js")""", rewritten, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InvokeAsync_FileTarget_ServesLocalHtmlDocument()
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "midterm-webpreview-file-target", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        var indexPath = Path.Combine(tempDir, "index.html");
        await File.WriteAllTextAsync(indexPath, "<html><head></head><body>preview</body></html>");

        try
        {
            var service = new WebPreviewService(serverPort: 2000);
            Assert.True(service.SetTarget("session-1", null, new Uri(indexPath).AbsoluteUri));
            Assert.True(service.TryGetPreviewRouteKey("session-1", null, out var routeKey));

            var middleware = new WebPreviewProxyMiddleware(_ => Task.CompletedTask, service);
            var context = new DefaultHttpContext();
            var responseBody = new MemoryStream();
            context.Features.Set<IHttpResponseBodyFeature>(new StreamResponseBodyFeature(responseBody));
            context.Request.Method = HttpMethods.Get;
            context.Request.Path = $"/webpreview/{routeKey}/";
            context.Request.Scheme = "https";
            context.Request.Host = new HostString("midterm.local");

            await middleware.InvokeAsync(context);

            responseBody.Position = 0;
            var html = await new StreamReader(responseBody, Encoding.UTF8).ReadToEndAsync();

            Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
            Assert.Contains("<body>preview</body>", html, StringComparison.Ordinal);
            Assert.Contains("<base href=\"/webpreview/", html, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    [Theory]
    [InlineData("/js/config.js", true, true)]
    [InlineData("/css/app.css", true, true)]
    [InlineData("/", true, true)]
    [InlineData("/login.html", true, true)]
    [InlineData("/js/html2canvas.min.js", true, false)]
    [InlineData("/ws/browser", true, false)]
    [InlineData("/js/config.js", false, false)]
    [InlineData("/assets/site.js", false, true)]
    public void ShouldProxyPreviewLeak_UsesPreviewRefererForConflictingAssetRoots(
        string path,
        bool hasPreviewReferer,
        bool expected)
    {
        var context = new DefaultHttpContext();
        if (hasPreviewReferer)
        {
            context.Request.Headers.Referer = "https://midterm.local/webpreview/route-a/";
        }

        var result = WebPreviewProxyMiddleware.ShouldProxyPreviewLeak(context.Request, path);

        Assert.Equal(expected, result);
    }

    [Fact]
    public void TryResolvePreviewFromRequest_UsesRememberedLeakedRefererPath()
    {
        var service = new WebPreviewService(serverPort: 2000);
        Assert.True(service.SetTarget("session-1", null, "https://example.com"));
        Assert.True(service.TryGetPreviewRouteKey("session-1", null, out var routeKey));
        service.RememberLeakedPathRoute(routeKey, "/js/login.js");
        var middleware = new WebPreviewProxyMiddleware(_ => Task.CompletedTask, service);

        var context = new DefaultHttpContext();
        context.Request.Path = "/router/router-lib.js";
        context.Request.Headers.Referer = "https://midterm.local/js/login.js";

        var resolved = middleware.TryResolvePreviewFromRequest(context.Request, out var resolvedRouteKey, out var targetUri);

        Assert.True(resolved);
        Assert.Equal(routeKey, resolvedRouteKey);
        Assert.Equal("https://example.com/", targetUri.ToString());
    }

    [Fact]
    public void TryResolvePreviewFromRequest_UsesRememberedLeakedRequestPath()
    {
        var service = new WebPreviewService(serverPort: 2000);
        Assert.True(service.SetTarget("session-1", null, "https://example.com"));
        Assert.True(service.TryGetPreviewRouteKey("session-1", null, out var routeKey));
        service.RememberLeakedPathRoute(routeKey, "/js/login.js");
        var middleware = new WebPreviewProxyMiddleware(_ => Task.CompletedTask, service);

        var context = new DefaultHttpContext();
        context.Request.Path = "/js/login.js";

        var resolved = middleware.TryResolvePreviewFromRequest(context.Request, out var resolvedRouteKey, out var targetUri);

        Assert.True(resolved);
        Assert.Equal(routeKey, resolvedRouteKey);
        Assert.Equal("https://example.com/", targetUri.ToString());
    }
}
