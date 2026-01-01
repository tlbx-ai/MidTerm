using Ai.Tlbx.MiddleManager.Settings;

namespace Ai.Tlbx.MiddleManager.Services;

public static class AuthEndpoints
{
    private static readonly CookieOptions SessionCookieOptions = new()
    {
        HttpOnly = true,
        SameSite = SameSiteMode.Strict,
        Secure = false,
        MaxAge = TimeSpan.FromHours(24)
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
                // Don't modify response for WebSocket upgrade requests
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    context.Response.Cookies.Append("mm-session", token, SessionCookieOptions);
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
        app.MapPost("/api/auth/login", async (HttpContext ctx) =>
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

            LoginRequest? request;
            try
            {
                request = await ctx.Request.ReadFromJsonAsync(AppJsonContext.Default.LoginRequest);
            }
            catch
            {
                return Results.Json(
                    new AuthResponse { Success = false, Error = "Invalid request" },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 400);
            }

            if (request is null || string.IsNullOrEmpty(request.Password))
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
            ctx.Response.Cookies.Append("mm-session", token, SessionCookieOptions);

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapPost("/api/auth/logout", (HttpContext ctx) =>
        {
            ctx.Response.Cookies.Delete("mm-session");
            return Results.Ok();
        });

        app.MapPost("/api/auth/change-password", async (HttpContext ctx) =>
        {
            ChangePasswordRequest? request;
            try
            {
                request = await ctx.Request.ReadFromJsonAsync(AppJsonContext.Default.ChangePasswordRequest);
            }
            catch
            {
                return Results.Json(
                    new AuthResponse { Success = false, Error = "Invalid request" },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 400);
            }

            if (request is null || string.IsNullOrEmpty(request.NewPassword))
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
            ctx.Response.Cookies.Append("mm-session", token, SessionCookieOptions);

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

    private static bool IsPublicPath(string path)
    {
        return path == "/login" ||
               path == "/login.html" ||
               path == "/api/health" ||
               path.StartsWith("/api/auth/") ||
               path.StartsWith("/css/") ||
               path.StartsWith("/js/") ||
               path.EndsWith(".ico") ||
               path.EndsWith(".png") ||
               path.EndsWith(".webmanifest");
    }
}
