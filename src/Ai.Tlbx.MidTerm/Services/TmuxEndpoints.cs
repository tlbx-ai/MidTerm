using Ai.Tlbx.MidTerm.Services.Tmux;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// REST endpoints for the tmux compatibility layer and direct session I/O.
/// </summary>
public static class TmuxEndpoints
{
    /// <summary>
    /// Map /api/tmux (command dispatch) and /api/tmux/layout (layout sync) endpoints.
    /// </summary>
    public static void MapTmuxEndpoints(
        WebApplication app,
        TmuxCommandDispatcher dispatcher,
        TmuxLayoutBridge layoutBridge)
    {
        app.MapPost("/api/tmux", async (HttpContext ctx) =>
        {
            using var ms = new MemoryStream();
            await ctx.Request.Body.CopyToAsync(ms);
            var body = ms.ToArray();

            var args = TmuxCommandParser.ParseNullDelimitedArgs(body);
            if (args.Count == 0)
            {
                TmuxLog.Error($"Empty request ({body.Length} bytes, no null-delimited args)");
                return Results.Text("no command specified\n", statusCode: 400);
            }

            var callerPaneId = ctx.Request.Headers["X-Tmux-Pane"].FirstOrDefault();
            TmuxLog.RawArgs(args, callerPaneId);
            var commands = TmuxCommandParser.Parse(args);

            var result = await dispatcher.DispatchAsync(commands, callerPaneId, ctx.RequestAborted);

            return Results.Text(
                result.Output,
                contentType: "text/plain",
                statusCode: 200);
        });

        app.MapPost("/api/tmux/layout", async (HttpContext ctx) =>
        {
            try
            {
                var node = await ctx.Request.ReadFromJsonAsync<LayoutNode>(
                    TmuxJsonContext.Default.LayoutNode, ctx.RequestAborted);
                layoutBridge.UpdateLayout(node);
                return Results.Ok();
            }
            catch
            {
                return Results.BadRequest();
            }
        });
    }

    /// <summary>
    /// Map /api/sessions/{id}/input and /api/sessions/{id}/buffer endpoints.
    /// </summary>
    public static void MapSessionInputEndpoint(
        WebApplication app,
        TtyHostSessionManager sessionManager)
    {
        app.MapPost("/api/sessions/{id}/input", async (string id, HttpContext ctx) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            using var ms = new MemoryStream();
            await ctx.Request.Body.CopyToAsync(ms);
            var data = ms.ToArray();

            if (data.Length == 0)
            {
                return Results.BadRequest("no input data");
            }

            await sessionManager.SendInputAsync(id, data, ctx.RequestAborted);
            return Results.Ok();
        });

        app.MapGet("/api/sessions/{id}/buffer", async (string id) =>
        {
            if (sessionManager.GetSession(id) is null)
            {
                return Results.NotFound();
            }

            var buffer = await sessionManager.GetBufferAsync(id);
            if (buffer is null)
            {
                return Results.NotFound();
            }

            return Results.Bytes(buffer, contentType: "application/octet-stream");
        });
    }
}
