using System.Security.Cryptography;
using System.Text;
using Ai.Tlbx.MidTerm.Services.Browser;
using Ai.Tlbx.MidTerm.Services.WebPreview;

namespace Ai.Tlbx.MidTerm.Startup;

internal static class PreviewProxyAuthorization
{
    internal const string RouteItemKey = "tlbx.authorized-preview-route";

    internal static bool TryAuthorize(HttpContext context, BrowserPreviewRegistry registry)
    {
        var request = context.Request;
        if (!TryGetRoute(request, out var routeKey)) return false;
        var cookieName = "mt-preview-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(routeKey)))[..16];
        var previewId = request.Query["__mtPreviewId"].ToString();
        var token = request.Query["__mtPreviewToken"].ToString();
        var bootstrap = !string.IsNullOrEmpty(previewId) || !string.IsNullOrEmpty(token);
        if (!bootstrap)
        {
            var cookie = request.Cookies[cookieName]?.Split(':', 2);
            if (cookie is not { Length: 2 }) return false;
            previewId = cookie[0];
            token = cookie[1];
        }

        if (!registry.TryValidate(previewId, token, out var registration)
            || !string.Equals(registration.RouteKey, routeKey, StringComparison.Ordinal)) return false;

        context.Items[RouteItemKey] = routeKey;
        if (bootstrap)
        {
            context.Response.Cookies.Append(cookieName, $"{previewId}:{token}", new CookieOptions
            {
                Secure = true,
                HttpOnly = true,
                SameSite = SameSiteMode.None,
                Path = "/",
                MaxAge = TimeSpan.FromHours(8),
                IsEssential = true
            });
        }
        return true;
    }

    internal static bool AllowsRoute(HttpContext context, string routeKey) =>
        !context.Items.TryGetValue(RouteItemKey, out var authorized)
        || string.Equals(authorized as string, routeKey, StringComparison.Ordinal);

    private static bool TryGetRoute(HttpRequest request, out string routeKey)
    {
        if (WebPreviewProxyMiddleware.TryParseProxyRoute(request.Path, out routeKey, out _)) return true;
        return Uri.TryCreate(request.Headers.Referer.ToString(), UriKind.Absolute, out var referer)
            && WebPreviewProxyMiddleware.TryParseProxyRoute(referer.AbsolutePath, out routeKey, out _);
    }
}
