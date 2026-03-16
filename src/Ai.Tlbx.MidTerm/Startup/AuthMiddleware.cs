using System.Net;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Share;
using Ai.Tlbx.MidTerm.Services.Updates;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class AuthMiddleware
{
    public static void ConfigureAuthMiddleware(
        WebApplication app,
        SettingsService settingsService,
        AuthService authService,
        ShareGrantService shareGrantService)
    {
        app.Use(async (context, next) =>
        {
            var authSettings = settingsService.Load();
            var path = context.Request.Path.Value ?? "";

            RequestAccessContext.SetFullUser(context, false);
            RequestAccessContext.SetShareAccess(context, null);

            var shareCookie = context.Request.Cookies[ShareGrantService.ShareCookieName];
            if (shareGrantService.TryResolveCookie(shareCookie, out var shareAccess))
            {
                RequestAccessContext.SetShareAccess(context, shareAccess);
            }

            if (!authSettings.AuthenticationEnabled || string.IsNullOrEmpty(authSettings.PasswordHash))
            {
                RequestAccessContext.SetFullUser(context, true);
                await next();
                return;
            }

            if (IsPublicPath(path))
            {
                await next();
                return;
            }

            if (path == "/api/shutdown" && IsLoopback(context))
            {
                await next();
                return;
            }

            if (IsShareProtectedPath(path))
            {
                if (shareAccess is not null)
                {
                    await next();
                    return;
                }

                context.Response.StatusCode = 401;
                return;
            }

            var requestAuthMethod = authService.AuthenticateRequest(context.Request);
            if (requestAuthMethod != RequestAuthMethod.None)
            {
                RequestAccessContext.SetFullUser(context, true);
                if (requestAuthMethod == RequestAuthMethod.SessionCookie && !context.WebSockets.IsWebSocketRequest)
                {
                    var freshToken = authService.CreateSessionToken();
                    context.Response.Cookies.Append(
                        AuthService.SessionCookieName,
                        freshToken,
                        GetSessionCookieOptions(settingsService));
                }
                await next();
                return;
            }

            if (path.StartsWith("/api/") || path.StartsWith("/ws/"))
            {
                context.Response.StatusCode = 401;
                return;
            }

            context.Response.Redirect("/login.html");
        });
    }

    private static CookieOptions GetSessionCookieOptions(SettingsService settingsService) => new()
    {
        HttpOnly = true,
        // Sandboxed previews use an opaque origin, so their subresource requests only
        // carry the auth cookie when dev mode intentionally relaxes SameSite.
        SameSite = UpdateService.IsDevEnvironment || settingsService.Load().DevMode
            ? SameSiteMode.None
            : SameSiteMode.Lax,
        Secure = true,
        Path = "/",
        MaxAge = TimeSpan.FromDays(3)
    };

    internal static bool IsPublicPath(string path)
    {
        return path == "/login" ||
               path == "/login.html" ||
               path == "/shared" ||
               path.StartsWith("/shared/", StringComparison.Ordinal) ||
               path == "/trust" ||
               path == "/trust.html" ||
               path == "/swagger" ||
               path.StartsWith("/swagger/", StringComparison.Ordinal) ||
               path.StartsWith("/openapi/", StringComparison.Ordinal) ||
               path == "/api/health" ||
               path == "/api/version" ||
               path == "/api/paths" ||
               path == "/api/security/status" ||
               path == "/api/share/claim" ||
               path.StartsWith("/api/certificate/") ||
               path.StartsWith("/api/auth/") ||
               path.StartsWith("/css/") ||
               path.StartsWith("/js/") ||
               path.StartsWith("/fonts/") ||
               path.StartsWith("/locales/") ||
               path.EndsWith(".ico") ||
               path.EndsWith(".png") ||
               path.EndsWith(".webmanifest") ||
               path.EndsWith(".woff") ||
               path.EndsWith(".woff2");
    }

    private static bool IsShareProtectedPath(string path)
    {
        return path == "/api/share/bootstrap" ||
               path == "/ws/share/state" ||
               path == "/ws/share/mux";
    }

    private static bool IsLoopback(HttpContext context)
    {
        var remoteIp = context.Connection.RemoteIpAddress;
        return remoteIp is not null && IPAddress.IsLoopback(remoteIp);
    }
}
