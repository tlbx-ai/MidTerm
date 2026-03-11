using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Services.Updates;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public static class AuthEndpoints
{
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
            ctx.Response.Cookies.Append(
                AuthService.SessionCookieName,
                token,
                GetSessionCookieOptions(settingsService));

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapPost("/api/auth/logout", (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete(AuthService.SessionCookieName, GetSessionCookieOptions(settingsService));
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
            ctx.Response.Cookies.Append(
                AuthService.SessionCookieName,
                token,
                GetSessionCookieOptions(settingsService));

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

    }

}
