using Ai.Tlbx.MidTerm.Services.WebPreview;
using Ai.Tlbx.MidTerm.Services.Browser;

namespace Ai.Tlbx.MidTerm.Services.Boards;

public static class BoardEndpoints
{
    public static void MapBoardEndpoints(WebApplication app, BoardService boards)
    {
        var previews = app.Services.GetRequiredService<WebPreviewService>();
        var registry = app.Services.GetRequiredService<BrowserPreviewRegistry>();
        var owners = app.Services.GetRequiredService<BrowserPreviewOwnerService>();
        app.MapGet("/api/boards", () => Results.Json(boards.List(), BoardJsonContext.Default.ListBoardDocument));
        app.MapPost("/api/boards", (BoardPatch request) => Try(() =>
            Results.Json(boards.Create(request), BoardJsonContext.Default.BoardDocument)));
        app.MapGet("/api/boards/{id}", (string id) => boards.Get(id) is { } board
            ? Results.Json(board, BoardJsonContext.Default.BoardDocument) : Results.NotFound());
        app.MapPatch("/api/boards/{id}", (string id, BoardPatch request) => Try(() => boards.Update(id, request) is { } board
            ? Results.Json(board, BoardJsonContext.Default.BoardDocument) : Results.NotFound()));
        app.MapDelete("/api/boards/{id}", (string id, long? expectedRevision) => Try(() =>
        {
            if (!boards.Delete(id, null, expectedRevision)) return Results.NotFound();
            var session = $"board-{id}";
            previews.ClearSession(session);
            registry.ClearSession(session);
            owners.ClearSession(session);
            return Results.NoContent();
        }));
        app.MapPost("/api/boards/{id}/items", (string id, BoardItemWrite request) => Try(() =>
            boards.WriteItem(id, null, request) is { } item
                ? Results.Json(item, BoardJsonContext.Default.BoardItem) : Results.NotFound()));
        app.MapGet("/api/boards/{id}/items/{itemId}", (string id, string itemId) => boards.GetItem(id, itemId) is { } item
            ? Results.Json(item, BoardJsonContext.Default.BoardItem) : Results.NotFound());
        app.MapPut("/api/boards/{id}/items/{itemId}", (string id, string itemId, BoardItemWrite request) => Try(() =>
            boards.WriteItem(id, itemId, request) is { } item
                ? Results.Json(item, BoardJsonContext.Default.BoardItem) : Results.NotFound()));
        app.MapDelete("/api/boards/{id}/items/{itemId}", (string id, string itemId, long? expectedRevision) => Try(() =>
        {
            var item = boards.GetItem(id, itemId);
            if (!boards.Delete(id, itemId, expectedRevision)) return Results.NotFound();
            if (item is { Kind: "browser", BrowserSessionId: null, BrowserPreviewName: null })
            {
                var session = $"board-{id}";
                previews.DeletePreviewSession(session, itemId);
                registry.Remove(session, itemId);
                owners.Release(session, itemId);
            }
            return Results.NoContent();
        }));
        app.MapPost("/api/boards/{id}/items/{itemId}/browser", (
            string id, string itemId) => Try(() =>
        {
            var item = boards.GetItem(id, itemId);
            if (item is null) return Results.NotFound();
            if (item.Kind != "browser") return Results.BadRequest("This item is not a browser tile.");
            var url = item.Url;
            if (item.LocalDirectory is { } directory)
            {
                var file = WebPreviewLocalDirectory.ResolveFile(directory, "index.html");
                if (file is null) return Results.BadRequest("Local program requires an index.html inside its directory.");
                url = new Uri(file).AbsoluteUri;
            }
            var session = item.BrowserSessionId ?? $"board-{id}";
            var preview = item.BrowserPreviewName ?? item.Id;
            if (url is not null && previews.GetTargetUrl(session, preview) != url
                && !previews.SetTarget(session, preview, url, localRoot: item.LocalDirectory))
                return Results.BadRequest("Unsupported browser target.");
            return Results.Json(previews.EnsurePreviewSession(session, preview), AppJsonContext.Default.WebPreviewSessionInfo);
        }));
    }

    private static IResult Try(Func<IResult> action)
    {
        try { return action(); }
        catch (BoardConflictException ex) { return Results.Problem(ex.Message, statusCode: 409); }
        catch (ArgumentException ex) { return Results.Problem(ex.Message, statusCode: 400); }
        catch (IOException) { return Results.Problem("Board storage is temporarily unavailable.", statusCode: 503); }
        catch (UnauthorizedAccessException) { return Results.Problem("Board storage is not accessible.", statusCode: 503); }
        catch (Microsoft.Data.Sqlite.SqliteException) { return Results.Problem("Board storage is temporarily unavailable.", statusCode: 503); }
    }
}
