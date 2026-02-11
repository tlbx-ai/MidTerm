using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services;

public static class CommandEndpoints
{
    public static void MapCommandEndpoints(WebApplication app, CommandService commandService, TtyHostSessionManager sessionManager)
    {
        app.MapGet("/api/commands", async (string sessionId) =>
        {
            var session = await sessionManager.GetSessionFreshAsync(sessionId);
            if (session is null)
            {
                return Results.BadRequest("Invalid session");
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.BadRequest("Session has no working directory");
            }

            var result = commandService.ListCommands(cwd);
            return Results.Json(result, AppJsonContext.Default.CommandListResponse);
        });

        app.MapPost("/api/commands", async (CreateCommandRequest request) =>
        {
            var session = await sessionManager.GetSessionFreshAsync(request.SessionId);
            if (session is null)
            {
                return Results.BadRequest("Invalid session");
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.BadRequest("Session has no working directory");
            }

            var cmd = commandService.CreateCommand(cwd, request.Name, request.Description, request.Commands);
            return Results.Json(cmd, AppJsonContext.Default.CommandDefinition);
        });

        app.MapPut("/api/commands/{filename}", async (string filename, UpdateCommandRequest request) =>
        {
            var session = await sessionManager.GetSessionFreshAsync(request.SessionId);
            if (session is null)
            {
                return Results.BadRequest("Invalid session");
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.BadRequest("Session has no working directory");
            }

            var cmd = commandService.UpdateCommand(cwd, filename, request.Name, request.Description, request.Commands);
            return cmd is null ? Results.NotFound() : Results.Json(cmd, AppJsonContext.Default.CommandDefinition);
        });

        app.MapDelete("/api/commands/{filename}", async (string filename, string sessionId) =>
        {
            var session = await sessionManager.GetSessionFreshAsync(sessionId);
            if (session is null)
            {
                return Results.BadRequest("Invalid session");
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.BadRequest("Session has no working directory");
            }

            return commandService.DeleteCommand(cwd, filename) ? Results.Ok() : Results.NotFound();
        });

        app.MapPost("/api/commands/reorder", async (ReorderCommandsRequest request) =>
        {
            var session = await sessionManager.GetSessionFreshAsync(request.SessionId);
            if (session is null)
            {
                return Results.BadRequest("Invalid session");
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.BadRequest("Session has no working directory");
            }

            commandService.ReorderCommands(cwd, request.Filenames);
            return Results.Ok();
        });

        app.MapPost("/api/commands/run", async (RunCommandRequest request) =>
        {
            var session = await sessionManager.GetSessionFreshAsync(request.SessionId);
            if (session is null)
            {
                return Results.BadRequest("Invalid session");
            }

            var cwd = session.CurrentDirectory;
            if (string.IsNullOrEmpty(cwd))
            {
                return Results.BadRequest("Session has no working directory");
            }

            try
            {
                var runId = commandService.RunCommand(cwd, request.Filename, session.ShellType);
                return Results.Ok(new { runId });
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapGet("/api/commands/run/{runId}/stream", async (string runId, HttpContext context) =>
        {
            var reader = commandService.GetRunOutput(runId);
            if (reader is null)
            {
                context.Response.StatusCode = 404;
                return;
            }

            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.Connection = "keep-alive";

            try
            {
                await foreach (var line in reader.ReadAllAsync(context.RequestAborted))
                {
                    await context.Response.WriteAsync($"data: {line}\n\n", context.RequestAborted);
                    await context.Response.Body.FlushAsync(context.RequestAborted);
                }

                var status = commandService.GetRunStatus(runId);
                await context.Response.WriteAsync($"event: done\ndata: {status?.Status ?? "completed"}\n\n", context.RequestAborted);
                await context.Response.Body.FlushAsync(context.RequestAborted);
            }
            catch (OperationCanceledException)
            {
                // Client disconnected
            }
        });

        app.MapPost("/api/commands/run/{runId}/cancel", (string runId) =>
        {
            return commandService.CancelRun(runId) ? Results.Ok() : Results.NotFound();
        });

        app.MapGet("/api/commands/run/{runId}/status", (string runId) =>
        {
            var status = commandService.GetRunStatus(runId);
            return status is null ? Results.NotFound() : Results.Json(status, AppJsonContext.Default.CommandRunStatus);
        });
    }
}
