using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public static class AuthEndpoints
{
    private static CookieOptions GetSessionCookieOptions() => new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Secure = true,  // Always HTTPS
        Path = "/",
        MaxAge = TimeSpan.FromDays(3)  // Sliding window - fresh token issued on each request
    };

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

            var token = context.Request.Cookies["mm-session"];
            if (token is not null && authService.ValidateSessionToken(token))
            {
                // Issue fresh token on each request for sliding window expiry
                // This ensures active users always have a recent token, while
                // stolen tokens expire after 3 days of attacker non-use
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    var freshToken = authService.CreateSessionToken();
                    context.Response.Cookies.Append("mm-session", freshToken, GetSessionCookieOptions());
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

    public static void MapAuthEndpoints(WebApplication app, SettingsService settingsService, AuthService authService)
    {
        app.MapPost("/api/auth/login", (LoginRequest request, HttpContext ctx) =>
        {
            var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

            if (authService.IsRateLimited(ip))
            {
                var remaining = authService.GetRemainingLockout(ip);
                return Results.Json(
                    new AuthResponse { Success = false, Error = $"Too many attempts. Try again in {remaining?.TotalSeconds:0} seconds." },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 429);
            }

            if (string.IsNullOrEmpty(request.Password))
            {
                return Results.Json(
                    new AuthResponse { Success = false, Error = "Password required" },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 400);
            }

            var loginSettings = settingsService.Load();
            if (!authService.VerifyPassword(request.Password, loginSettings.PasswordHash))
            {
                authService.RecordFailedAttempt(ip);
                return Results.Json(
                    new AuthResponse { Success = false, Error = "Invalid password" },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 401);
            }

            authService.ResetAttempts(ip);
            var token = authService.CreateSessionToken();
            ctx.Response.Cookies.Append("mm-session", token, GetSessionCookieOptions());

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapPost("/api/auth/logout", (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete("mm-session");
            return Results.Ok();
        });

        app.MapPost("/api/auth/change-password", (ChangePasswordRequest request, HttpContext ctx) =>
        {
            if (string.IsNullOrEmpty(request.NewPassword))
            {
                return Results.Json(
                    new AuthResponse { Success = false, Error = "New password required" },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 400);
            }

            var pwSettings = settingsService.Load();

            if (!string.IsNullOrEmpty(pwSettings.PasswordHash))
            {
                if (string.IsNullOrEmpty(request.CurrentPassword) ||
                    !authService.VerifyPassword(request.CurrentPassword, pwSettings.PasswordHash))
                {
                    return Results.Json(
                        new AuthResponse { Success = false, Error = "Current password is incorrect" },
                        AppJsonContext.Default.AuthResponse,
                        statusCode: 401);
                }
            }

            pwSettings.PasswordHash = authService.HashPassword(request.NewPassword);
            pwSettings.AuthenticationEnabled = true;
            authService.InvalidateAllSessions();
            settingsService.Save(pwSettings);

            var token = authService.CreateSessionToken();
            ctx.Response.Cookies.Append("mm-session", token, GetSessionCookieOptions());

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapGet("/api/auth/status", () =>
        {
            var statusSettings = settingsService.Load();
            return Results.Json(new AuthStatusResponse
            {
                AuthenticationEnabled = statusSettings.AuthenticationEnabled,
                PasswordSet = !string.IsNullOrEmpty(statusSettings.PasswordHash)
            }, AppJsonContext.Default.AuthStatusResponse);
        });

        // Security status endpoint - reports password/certificate health
        // Accessible without authentication to allow monitoring
        var securityStatusService = app.Services.GetRequiredService<SecurityStatusService>();
        app.MapGet("/api/security/status", () =>
        {
            return Results.Json(securityStatusService.GetStatus(), AppJsonContext.Default.SecurityStatus);
        });
    }

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
               path == "/api/shutdown" ||
               path.StartsWith("/api/certificate/") ||
               path.StartsWith("/api/auth/") ||
               path.StartsWith("/css/") ||
               path.StartsWith("/js/") ||
               path.StartsWith("/fonts/") ||
               path.EndsWith(".ico") ||
               path.EndsWith(".png") ||
               path.EndsWith(".webmanifest") ||
               path.EndsWith(".woff") ||
               path.EndsWith(".woff2");
    }
}
