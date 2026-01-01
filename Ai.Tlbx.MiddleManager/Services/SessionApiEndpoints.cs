using System.Text;
using Ai.Tlbx.MiddleManager.Models;
using Ai.Tlbx.MiddleManager.Shells;

namespace Ai.Tlbx.MiddleManager.Services;

public static class SessionApiEndpoints
{
    public static void MapSessionEndpoints(
        WebApplication app,
        ConHostSessionManager? conHostManager,
        SessionManager? directManager)
    {
        app.MapGet("/api/sessions", () =>
        {
            if (conHostManager is not null)
            {
                return Results.Json(conHostManager.GetSessionList(), AppJsonContext.Default.SessionListDto);
            }
            return Results.Json(directManager!.GetSessionList(), AppJsonContext.Default.SessionListDto);
        });

        app.MapPost("/api/sessions", async (CreateSessionRequest? request) =>
        {
            var cols = request?.Cols ?? 120;
            var rows = request?.Rows ?? 30;

            ShellType? shellType = null;
            if (!string.IsNullOrEmpty(request?.Shell) && Enum.TryParse<ShellType>(request.Shell, true, out var parsed))
            {
                shellType = parsed;
            }

            if (conHostManager is not null)
            {
                var sessionInfo = await conHostManager.CreateSessionAsync(
                    shellType?.ToString(), cols, rows, request?.WorkingDirectory);

                if (sessionInfo is null)
                {
                    return Results.Problem("Failed to create session");
                }

                return Results.Json(MapToDto(sessionInfo), AppJsonContext.Default.SessionInfoDto);
            }
            else
            {
                var session = directManager!.CreateSession(cols, rows, shellType);
                return Results.Json(new SessionInfoDto
                {
                    Id = session.Id,
                    Pid = session.Pid,
                    CreatedAt = session.CreatedAt,
                    IsRunning = session.IsRunning,
                    ExitCode = session.ExitCode,
                    CurrentWorkingDirectory = session.CurrentWorkingDirectory,
                    Cols = session.Cols,
                    Rows = session.Rows,
                    ShellType = session.ShellType.ToString(),
                    Name = session.Name
                }, AppJsonContext.Default.SessionInfoDto);
            }
        });

        app.MapDelete("/api/sessions/{id}", async (string id) =>
        {
            if (conHostManager is not null)
            {
                await conHostManager.CloseSessionAsync(id);
            }
            else
            {
                directManager!.CloseSession(id);
            }
            return Results.Ok();
        });

        app.MapPost("/api/sessions/{id}/resize", async (string id, ResizeRequest request) =>
        {
            if (conHostManager is not null)
            {
                var session = conHostManager.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                await conHostManager.ResizeSessionAsync(id, request.Cols, request.Rows);
                return Results.Json(new ResizeResponse
                {
                    Accepted = true,
                    Cols = request.Cols,
                    Rows = request.Rows
                }, AppJsonContext.Default.ResizeResponse);
            }
            else
            {
                var session = directManager!.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                var accepted = session.Resize(request.Cols, request.Rows);
                return Results.Json(new ResizeResponse
                {
                    Accepted = accepted,
                    Cols = session.Cols,
                    Rows = session.Rows
                }, AppJsonContext.Default.ResizeResponse);
            }
        });

        app.MapGet("/api/sessions/{id}/buffer", async (string id) =>
        {
            if (conHostManager is not null)
            {
                var session = conHostManager.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                var buffer = await conHostManager.GetBufferAsync(id);
                return Results.Bytes(buffer ?? []);
            }
            else
            {
                var session = directManager!.GetSession(id);
                if (session is null)
                {
                    return Results.NotFound();
                }
                return Results.Text(session.GetBuffer());
            }
        });

        app.MapPut("/api/sessions/{id}/name", async (string id, RenameSessionRequest request) =>
        {
            if (conHostManager is not null)
            {
                if (!await conHostManager.SetSessionNameAsync(id, request.Name))
                {
                    return Results.NotFound();
                }
                return Results.Ok();
            }
            else
            {
                if (!directManager!.RenameSession(id, request.Name))
                {
                    return Results.NotFound();
                }
                return Results.Ok();
            }
        });
    }

    private static SessionInfoDto MapToDto(SessionInfo sessionInfo)
    {
        return new SessionInfoDto
        {
            Id = sessionInfo.Id,
            Pid = sessionInfo.Pid,
            CreatedAt = sessionInfo.CreatedAt,
            IsRunning = sessionInfo.IsRunning,
            ExitCode = sessionInfo.ExitCode,
            CurrentWorkingDirectory = sessionInfo.CurrentWorkingDirectory,
            Cols = sessionInfo.Cols,
            Rows = sessionInfo.Rows,
            ShellType = sessionInfo.ShellType,
            Name = sessionInfo.Name
        };
    }
}
