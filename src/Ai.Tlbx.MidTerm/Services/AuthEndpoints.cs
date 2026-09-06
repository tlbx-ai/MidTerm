using System.Globalization;
using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public static class AuthEndpoints
{
    private static CookieOptions GetSessionCookieOptions() => new()
    {
        HttpOnly = true,
        // Preview access uses a separate route-scoped credential.
        SameSite = SameSiteMode.Lax,
        Secure = true,
        Path = "/",
        MaxAge = AuthService.SessionTokenValidity
    };

    public static void MapAuthEndpoints(WebApplication app, SettingsService settingsService, AuthService authService)
    {
        app.MapPost("/api/auth/login", (LoginRequest request, HttpContext ctx) =>
        {
            var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            using var passwordOperation = authService.TryBeginPasswordOperation();
            if (passwordOperation is null) return Results.StatusCode(StatusCodes.Status429TooManyRequests);


            if (authService.IsRateLimited(ip))
            {
                var remaining = authService.GetRemainingLockout(ip);
                return Results.Json(
                    new AuthResponse
                    {
                        Success = false,
                        Error = string.Create(CultureInfo.InvariantCulture, $"Too many attempts. Try again in {remaining?.TotalSeconds:0} seconds.")
                    },
                    AppJsonContext.Default.AuthResponse,
                    statusCode: 429);
            }

            if (string.IsNullOrEmpty(request.Password) || request.Password.Length > AuthService.MaximumPasswordLength)
            {
                return Results.Json(
                    new AuthResponse { Success = false, Error = "Password required (maximum 1024 characters)" },
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

            if (AuthService.NeedsPasswordHashUpgrade(loginSettings.PasswordHash!))
            {
                loginSettings.PasswordHash = authService.HashPassword(request.Password);
                settingsService.Save(loginSettings);
            }
            authService.ResetAttempts(ip);
            var token = authService.CreateSessionToken();
            ctx.Response.Cookies.Append(
                AuthService.SessionCookieName,
                token,
                GetSessionCookieOptions());

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapPost("/api/auth/logout", (HttpContext ctx) =>
        {
            authService.RevokeSessionToken(ctx.Request.Cookies[AuthService.SessionCookieName]);
            ctx.Response.Cookies.Delete(AuthService.SessionCookieName, GetSessionCookieOptions());
            return Results.Ok();
        });

        app.MapPost("/api/auth/refresh", (HttpContext ctx) =>
        {
            var authentication = authService.AuthenticateRequestWithContext(ctx.Request);
            if (authentication.Method == RequestAuthMethod.None)
            {
                AuthService.MarkAuthenticationRequired(ctx.Response);
                return Results.Unauthorized();
            }

            if (authentication.Method == RequestAuthMethod.SessionCookie)
            {
                ctx.Response.Cookies.Append(
                    AuthService.SessionCookieName,
                    authService.RenewSessionToken(authentication.SessionTokenId!),
                    GetSessionCookieOptions());
            }

            return Results.NoContent();
        });

        app.MapPost("/api/auth/change-password", (ChangePasswordRequest request, HttpContext ctx) =>
        {
            using var passwordOperation = authService.TryBeginPasswordOperation();
            if (passwordOperation is null) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            if (authService.IsRateLimited(ip)) return Results.StatusCode(StatusCodes.Status429TooManyRequests);

            var passwordError = AuthService.ValidateNewPassword(request.NewPassword);
            if (passwordError is not null)
            {
                return Results.Json(new AuthResponse { Success = false, Error = passwordError },
                    AppJsonContext.Default.AuthResponse, statusCode: 400);
            }

            var pwSettings = settingsService.Load();
            if (string.IsNullOrEmpty(request.CurrentPassword)
                || !authService.VerifyPassword(request.CurrentPassword, pwSettings.PasswordHash))
            {
                authService.RecordFailedAttempt(ip);
                return Results.Json(new AuthResponse { Success = false, Error = "Current password is incorrect" },
                    AppJsonContext.Default.AuthResponse, statusCode: 401);
            }
            authService.ResetAttempts(ip);

            pwSettings.PasswordHash = authService.HashPassword(request.NewPassword);
            pwSettings.AuthenticationEnabled = true;
            settingsService.Save(pwSettings);
            authService.InvalidateAllSessions();

            var token = authService.CreateSessionToken();
            ctx.Response.Cookies.Append(
                AuthService.SessionCookieName,
                token,
                GetSessionCookieOptions());

            return Results.Json(new AuthResponse { Success = true }, AppJsonContext.Default.AuthResponse);
        });

        app.MapGet("/api/auth/status", () =>
        {
            var statusSettings = settingsService.Load();
            return Results.Json(new AuthStatusResponse
            {
                AuthenticationEnabled = true,
                PasswordSet = !string.IsNullOrEmpty(statusSettings.PasswordHash)
            }, AppJsonContext.Default.AuthStatusResponse);
        });

    }

}
