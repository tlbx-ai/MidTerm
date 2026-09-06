using Ai.Tlbx.MidTerm.Startup;
using Ai.Tlbx.MidTerm.Services.Browser;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class PreviewProxyAuthorizationTests
{
    [Fact]
    public void PreviewPathAndReferer_AreNotCredentials()
    {
        var registry = new BrowserPreviewRegistry();
        var context = Context("/webpreview/route-a/");
        Assert.False(PreviewProxyAuthorization.TryAuthorize(context, registry));
        context.Request.Path = "/api/private";
        context.Request.Headers.Referer = "https://host:2001/webpreview/route-a/";
        Assert.False(PreviewProxyAuthorization.TryAuthorize(context, registry));
    }

    [Fact]
    public void BootstrapCredential_IsBoundToItsRouteAndCanBeRevoked()
    {
        var registry = new BrowserPreviewRegistry();
        var grant = registry.Create("session-a", "default", "route-a");
        var context = Context("/webpreview/route-b/");
        context.Request.QueryString = new QueryString($"?__mtPreviewId={grant.PreviewId}&__mtPreviewToken={grant.PreviewToken}");
        Assert.False(PreviewProxyAuthorization.TryAuthorize(context, registry));
        context.Request.Path = "/webpreview/route-a/";
        Assert.True(PreviewProxyAuthorization.TryAuthorize(context, registry));
        Assert.True(PreviewProxyAuthorization.AllowsRoute(context, "route-a"));
        Assert.False(PreviewProxyAuthorization.AllowsRoute(context, "route-b"));

        var cookie = context.Response.Headers.SetCookie.ToString();
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        var followup = Context("/webpreview/route-a/asset.js");
        followup.Request.Headers.Cookie = cookie.Split(';')[0];
        Assert.True(PreviewProxyAuthorization.TryAuthorize(followup, registry));
        registry.ClearSession("session-a");
        Assert.False(PreviewProxyAuthorization.TryAuthorize(followup, registry));
    }

    [Fact]
    public void PreviewPort_UsesTheListenerRatherThanAnUntrustedHostHeader()
    {
        var origin = new BrowserPreviewOriginService(2000, 2001, true);
        var context = Context("/api/sessions");
        context.Connection.LocalPort = 2000;
        Assert.False(origin.IsPreviewRequest(context));
        context.Request.Host = new HostString("host", 2000);
        context.Connection.LocalPort = 2001;
        Assert.True(origin.IsPreviewRequest(context));
    }

    private static DefaultHttpContext Context(string path)
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("host", 2001);
        context.Connection.LocalPort = 2001;
        context.Request.Path = path;
        return context;
    }
}
