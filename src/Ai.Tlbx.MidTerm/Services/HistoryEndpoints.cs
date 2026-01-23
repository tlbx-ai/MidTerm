using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services;

public static class HistoryEndpoints
{
    public static void MapHistoryEndpoints(WebApplication app, HistoryService historyService, TtyHostSessionManager sessionManager)
    {
        app.MapGet("/api/history", () =>
        {
            return Results.Json(historyService.GetEntries(), AppJsonContext.Default.ListLaunchEntry);
        });

        app.MapPost("/api/history", (CreateHistoryRequest request) =>
        {
            var id = historyService.RecordEntry(
                request.ShellType,
                request.Executable,
                request.CommandLine,
                request.WorkingDirectory);

            if (id is null)
            {
                return Results.BadRequest("Invalid history entry");
            }

            if (request.IsStarred)
            {
                historyService.SetStarred(id, true);
            }

            return Results.Ok(new { id });
        });

        // PATCH /api/history/{id} - update history entry (currently only supports isStarred)
        app.MapPatch("/api/history/{id}", (string id, HistoryPatchRequest request) =>
        {
            if (request.IsStarred.HasValue)
            {
                if (!historyService.SetStarred(id, request.IsStarred.Value))
                {
                    return Results.NotFound();
                }
            }
            return Results.Ok();
        });

        // Legacy PUT star endpoint kept for backward compatibility
        app.MapPut("/api/history/{id}/star", (string id) =>
        {
            if (historyService.ToggleStar(id))
            {
                return Results.Ok();
            }
            return Results.NotFound();
        });

        app.MapDelete("/api/history/{id}", (string id) =>
        {
            if (historyService.RemoveEntry(id))
            {
                return Results.Ok();
            }
            return Results.NotFound();
        });

    }
}
