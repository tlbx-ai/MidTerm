using Ai.Tlbx.MidTerm.Models.Share;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Share;

public static class ShareEndpoints
{
    public static void MapShareEndpoints(
        WebApplication app,
        ShareGrantService shareGrantService,
        TtyHostSessionManager sessionManager,
        SettingsService settingsService)
    {
        app.MapPost("/api/share/create", (CreateShareLinkRequest request, HttpContext ctx) =>
        {
            if (sessionManager.GetSession(request.SessionId) is null)
            {
                return Results.NotFound();
            }

            var issued = shareGrantService.CreateGrant(request.SessionId, request.Mode);
            var networkInterfaces = NetworkInterfaceFilter.GetNetworkInterfaces();

            var response = new CreateShareLinkResponse
            {
                GrantId = issued.GrantId,
                Mode = issued.Mode,
                ExpiresAtUtc = issued.ExpiresAtUtc,
                ShareUrl = ShareUrlBuilder.BuildShareUrl(
                    ctx.Request,
                    networkInterfaces,
                    issued.GrantId,
                    issued.Secret,
                    request.ShareHost)
            };

            return Results.Json(response, AppJsonContext.Default.CreateShareLinkResponse);
        });

        app.MapGet("/api/share/active", (int? limit) =>
        {
            var maxCount = Math.Clamp(limit ?? 6, 0, 6);
            var sessions = sessionManager.GetSessionList().Sessions
                .ToDictionary(session => session.Id, StringComparer.Ordinal);

            var response = new ActiveShareGrantListResponse
            {
                Shares = shareGrantService.GetActiveGrants(maxCount)
                    .Select(grant =>
                    {
                        sessions.TryGetValue(grant.SessionId, out var session);
                        return new ActiveShareGrantInfo
                        {
                            GrantId = grant.GrantId,
                            SessionId = grant.SessionId,
                            SessionName = session?.Name ?? session?.TerminalTitle ?? grant.SessionId,
                            Mode = grant.Mode,
                            CreatedAtUtc = grant.CreatedAtUtc,
                            ExpiresAtUtc = grant.ExpiresAtUtc
                        };
                    })
                    .ToList()
            };

            return Results.Json(response, AppJsonContext.Default.ActiveShareGrantListResponse);
        });

        app.MapDelete("/api/share/{grantId}", (string grantId) =>
        {
            return shareGrantService.RevokeGrant(grantId)
                ? Results.NoContent()
                : Results.NotFound();
        });

        app.MapPost("/api/share/claim", (ClaimShareRequest request, HttpContext ctx) =>
        {
            if (!shareGrantService.TryClaim(request.GrantId, request.Secret, out var access, out var cookieValue))
            {
                ctx.Response.Cookies.Delete(ShareGrantService.ShareCookieName, new CookieOptions
                {
                    Secure = true,
                    HttpOnly = true,
                    Path = "/"
                });
                return Results.Unauthorized();
            }

            ctx.Response.Cookies.Append(
                ShareGrantService.ShareCookieName,
                cookieValue,
                BuildShareCookieOptions(settingsService, access.ExpiresAtUtc));

            var response = new ClaimShareResponse
            {
                GrantId = access.GrantId,
                SessionId = access.SessionId,
                Mode = access.Mode,
                ExpiresAtUtc = access.ExpiresAtUtc
            };

            return Results.Json(response, AppJsonContext.Default.ClaimShareResponse);
        }).AllowAnonymous();

        app.MapGet("/api/share/bootstrap", (HttpContext ctx) =>
        {
            var access = RequestAccessContext.GetShareAccess(ctx);
            if (access is null)
            {
                return Results.Unauthorized();
            }

            var session = sessionManager.GetSessionList().Sessions
                .FirstOrDefault(s => string.Equals(s.Id, access.SessionId, StringComparison.Ordinal));
            if (session is null)
            {
                return Results.NotFound();
            }

            var response = new ShareBootstrapResponse
            {
                Hostname = Environment.MachineName,
                Session = session,
                Settings = BuildSharedSettings(settingsService.Load()),
                Mode = access.Mode,
                ExpiresAtUtc = access.ExpiresAtUtc
            };

            return Results.Json(response, AppJsonContext.Default.ShareBootstrapResponse);
        });
    }

    public static MidTermSettingsPublic BuildSharedSettings(MidTermSettings settings)
    {
        var shared = MidTermSettingsPublic.FromSettings(settings);
        shared.DefaultWorkingDirectory = "";
        shared.RunAsUser = null;
        shared.RunAsUserSid = null;
        shared.AuthenticationEnabled = false;
        shared.CertificatePath = null;
        shared.ManagerBarEnabled = false;
        shared.FileRadar = false;
        return shared;
    }

    public static CookieOptions BuildShareCookieOptions(SettingsService settingsService, DateTime expiresAtUtc)
    {
        var remaining = expiresAtUtc - DateTime.UtcNow;
        if (remaining < TimeSpan.Zero)
        {
            remaining = TimeSpan.Zero;
        }

        return new CookieOptions
        {
            HttpOnly = true,
            SameSite = Updates.UpdateService.IsDevEnvironment || settingsService.Load().DevMode
                ? SameSiteMode.None
                : SameSiteMode.Lax,
            Secure = true,
            Path = "/",
            MaxAge = remaining
        };
    }
}
