using System.Net;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class AuthMiddleware
{
    public static void ConfigureAuthMiddleware(WebApplication app, SettingsService settingsService, AuthService authService)
    {
        app.Use(async (context, next) =>
        {
            var authSettings = settingsService.Load();
            var path = context.Request.Path.Value ?? "";

            if (!authSettings.AuthenticationEnabled || string.IsNullOrEmpty(authSettings.PasswordHash))
            {
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

            var token = context.Request.Cookies[AuthService.SessionCookieName];
            if (token is not null && authService.ValidateSessionToken(token))
            {
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    var freshToken = authService.CreateSessionToken();
                    context.Response.Cookies.Append(AuthService.SessionCookieName, freshToken, GetSessionCookieOptions());
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

    private static CookieOptions GetSessionCookieOptions() => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Secure = true,
        Path = "/",
        MaxAge = TimeSpan.FromDays(3)
    };

    private static bool IsPublicPath(string path)
    {
        return path == "/login" ||
               path == "/login.html" ||
               path == "/trust" ||
               path == "/trust.html" ||
               path == "/api/health" ||
               path == "/api/version" ||
               path == "/api/paths" ||
               path == "/api/security/status" ||
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

    private static bool IsLoopback(HttpContext context)
    {
        var remoteIp = context.Connection.RemoteIpAddress;
        return remoteIp is not null && IPAddress.IsLoopback(remoteIp);
    }
}
