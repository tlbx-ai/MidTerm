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

            var result = commandService.ListScripts(cwd);
            return Results.Json(result, AppJsonContext.Default.ScriptListResponse);
        });

        app.MapPost("/api/commands", async (CreateScriptRequest request) =>
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

            var script = commandService.CreateScript(cwd, request.Name, request.Extension, request.Content);
            return Results.Json(script, AppJsonContext.Default.ScriptDefinition);
        });

        app.MapPut("/api/commands/{filename}", async (string filename, UpdateScriptRequest request) =>
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

            var script = commandService.UpdateScript(cwd, filename, request.Content);
            return script is null ? Results.NotFound() : Results.Json(script, AppJsonContext.Default.ScriptDefinition);
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

            return commandService.DeleteScript(cwd, filename) ? Results.Ok() : Results.NotFound();
        });

        app.MapPost("/api/commands/run", async (RunScriptRequest request) =>
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
                var result = await commandService.RunScriptAsync(cwd, request.Filename, sessionManager);
                return Results.Json(result, AppJsonContext.Default.RunScriptResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        app.MapPost("/api/commands/stop", async (StopScriptRequest request) =>
        {
            if (string.IsNullOrEmpty(request.HiddenSessionId))
            {
                return Results.BadRequest("Missing hiddenSessionId");
            }

            await sessionManager.CloseSessionAsync(request.HiddenSessionId);
            return Results.Ok();
        });
    }
}
