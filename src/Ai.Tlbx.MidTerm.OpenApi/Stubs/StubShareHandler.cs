using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.Share;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public sealed class StubShareHandler : IShareHandler
{
    public IResult CreateShareLink(CreateShareLinkRequest request)
    {
        var host = string.IsNullOrWhiteSpace(request.ShareHost)
            ? "localhost"
            : request.ShareHost;

        return Results.Json(new CreateShareLinkResponse
        {
            ShareUrl = $"https://{host}:2000/shared/grant-id#secret",
            GrantId = "grant-id",
            Mode = request.Mode,
            ExpiresAtUtc = DateTime.UtcNow.AddHours(1)
        });
    }

    public IResult GetActiveShares(int? limit)
    {
        var maxCount = Math.Clamp(limit ?? 6, 0, 6);
        var shares = Enumerable.Range(1, maxCount)
            .Select(index => new ActiveShareGrantInfo
            {
                GrantId = $"grant-{index}",
                SessionId = $"session-{index}",
                SessionName = $"Shared Session {index}",
                Mode = index % 2 == 0 ? ShareAccessMode.ViewOnly : ShareAccessMode.FullControl,
                CreatedAtUtc = DateTime.UtcNow.AddMinutes(-index * 5),
                ExpiresAtUtc = DateTime.UtcNow.AddMinutes(60 - (index * 5))
            })
            .ToList();

        return Results.Json(new ActiveShareGrantListResponse
        {
            Shares = shares
        });
    }

    public IResult RevokeShare(string grantId) =>
        string.IsNullOrWhiteSpace(grantId) ? Results.NotFound() : Results.NoContent();

    public IResult ClaimShareLink(ClaimShareRequest request) =>
        Results.Json(new ClaimShareResponse
        {
            GrantId = request.GrantId,
            SessionId = "session-id",
            Mode = ShareAccessMode.ViewOnly,
            ExpiresAtUtc = DateTime.UtcNow.AddHours(1)
        });

    public IResult GetShareBootstrap() =>
        Results.Json(new ShareBootstrapResponse
        {
            Hostname = "midterm",
            Session = new Models.Sessions.SessionInfoDto
            {
                Id = "session-id",
                CreatedAt = DateTime.UtcNow,
                Pid = 0,
                IsRunning = true,
                ExitCode = null,
                Cols = 120,
                Rows = 30,
                ShellType = "Pwsh",
                Name = "Shared",
                TerminalTitle = "Shared",
                ManuallyNamed = true,
                CurrentDirectory = "",
                ForegroundPid = null,
                ForegroundName = null,
                ForegroundCommandLine = null,
                Order = 0,
                ParentSessionId = null,
                BookmarkId = null
            },
            Settings = new Settings.MidTermSettingsPublic(),
            Mode = ShareAccessMode.ViewOnly,
            ExpiresAtUtc = DateTime.UtcNow.AddHours(1)
        });
}
