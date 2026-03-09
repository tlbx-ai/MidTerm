using Ai.Tlbx.MidTerm.Services.WebPreview;
using Ai.Tlbx.MidTerm.Services.Browser;
using Microsoft.AspNetCore.Http;
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
}
