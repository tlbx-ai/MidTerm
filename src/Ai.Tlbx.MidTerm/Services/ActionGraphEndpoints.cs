using Ai.Tlbx.MidTerm.Models.ActionGraphs;

namespace Ai.Tlbx.MidTerm.Services;

public static class ActionGraphEndpoints
{
    public static void MapActionGraphEndpoints(WebApplication app, ActionGraphService graphs)
    {
        app.MapGet("/api/graphs", (string? scope) => Try(() => Results.Json(
            graphs.ListGraphs(scope),
            AppJsonContext.Default.ActionGraphListResponse)));

        app.MapGet("/api/graph-scopes", () => Results.Json(
            graphs.ListScopes(),
            AppJsonContext.Default.ActionGraphScopeListResponse));

        app.MapPost("/api/graph-scopes", (CreateActionGraphScopeRequest request) =>
            Try(() => Results.Json(
                graphs.CreateScope(request),
                AppJsonContext.Default.ActionGraphScope)));

        app.MapPatch("/api/graph-scopes/{scopeId}", (string scopeId, RenameActionGraphScopeRequest request) =>
            Try(() => graphs.RenameScope(scopeId, request) ? Results.Ok() : Results.NotFound()));

        app.MapDelete("/api/graph-scopes/{scopeId}", (string scopeId) =>
            Try(() => graphs.DeleteScope(scopeId) ? Results.Ok() : Results.NotFound()));

        app.MapPost("/api/graphs", (CreateActionGraphRequest request) =>
            Try(() => Results.Json(
                graphs.CreateGraph(request),
                AppJsonContext.Default.ActionGraph)));

        app.MapGet("/api/graphs/{graphId}", (string graphId) => Try(() =>
        {
            var graph = graphs.GetGraph(graphId);
            return graph is null
                ? Results.NotFound()
                : Results.Json(graph, AppJsonContext.Default.ActionGraph);
        }));

        app.MapGet("/api/graphs/{graphId}/nodes/{nodeId}/context", (
            string graphId,
            string nodeId,
            int? depth,
            int? limit) => Try(() =>
        {
            var context = graphs.GetNodeContext(graphId, nodeId, depth ?? 1, limit ?? 120);
            return context is null
                ? Results.NotFound()
                : Results.Json(context, AppJsonContext.Default.ActionGraphContextResponse);
        }));

        app.MapDelete("/api/graphs/{graphId}", (string graphId, int? expectedRevision) => Try(() =>
            graphs.DeleteGraph(graphId, expectedRevision) ? Results.Ok() : Results.NotFound()));

        app.MapPost("/api/graphs/{graphId}/organize", (
            string graphId,
            OrganizeActionGraphRequest request) => Try(() =>
        {
            var graph = graphs.OrganizeGraph(graphId, request.ExpectedGraphRevision);
            return graph is null
                ? Results.NotFound()
                : Results.Json(graph, AppJsonContext.Default.ActionGraph);
        }));

        app.MapPost("/api/graphs/{graphId}/nodes", (string graphId, UpsertActionGraphNodeRequest request) =>
            Try(() => Results.Json(
                graphs.CreateNode(graphId, request),
                AppJsonContext.Default.ActionGraphNode)));

        app.MapPatch("/api/graphs/{graphId}/nodes/{nodeId}", (
            string graphId,
            string nodeId,
            UpsertActionGraphNodeRequest request) => Try(() =>
        {
            var node = graphs.UpdateNode(graphId, nodeId, request);
            return node is null
                ? Results.NotFound()
                : Results.Json(node, AppJsonContext.Default.ActionGraphNode);
        }));

        app.MapPost("/api/graphs/{graphId}/nodes/{nodeId}/position", (
            string graphId,
            string nodeId,
            SetActionGraphNodePositionRequest request) => Try(() =>
        {
            var node = graphs.SetNodePosition(graphId, nodeId, request.X, request.Y, request.ExpectedRevision);
            return node is null
                ? Results.NotFound()
                : Results.Json(node, AppJsonContext.Default.ActionGraphNode);
        }));

        app.MapDelete("/api/graphs/{graphId}/nodes/{nodeId}", (
            string graphId,
            string nodeId,
            int? expectedRevision,
            int? expectedGraphRevision) => Try(() =>
            graphs.DeleteNode(graphId, nodeId, expectedRevision, expectedGraphRevision)
                ? Results.Ok()
                : Results.NotFound()));

        app.MapPost("/api/graphs/{graphId}/nodes/{nodeId}/sessions", (
            string graphId,
            string nodeId,
            BindActionGraphSessionRequest request) => Try(() =>
        {
            var node = graphs.BindSession(graphId, nodeId, request);
            return node is null
                ? Results.NotFound()
                : Results.Json(node, AppJsonContext.Default.ActionGraphNode);
        }));

        app.MapDelete("/api/graphs/{graphId}/nodes/{nodeId}/sessions/{sessionId}", (
            string graphId,
            string nodeId,
            string sessionId,
            int? expectedGraphRevision) => Try(() =>
            graphs.UnbindSession(graphId, nodeId, sessionId, expectedGraphRevision)
                ? Results.Ok()
                : Results.NotFound()));

        app.MapPost("/api/graphs/{graphId}/edges", (string graphId, CreateActionGraphEdgeRequest request) =>
            Try(() => Results.Json(
                graphs.CreateEdge(graphId, request),
                AppJsonContext.Default.ActionGraphEdge)));

        app.MapDelete("/api/graphs/{graphId}/edges/{edgeId}", (
            string graphId,
            string edgeId,
            int? expectedGraphRevision) => Try(() =>
            graphs.DeleteEdge(graphId, edgeId, expectedGraphRevision) ? Results.Ok() : Results.NotFound()));
    }

    private static IResult Try(Func<IResult> action)
    {
        try
        {
            return action();
        }
        catch (ArgumentException ex)
        {
            return Results.BadRequest(ex.Message);
        }
        catch (ActionGraphConflictException ex)
        {
            return Results.Json(
                new ActionGraphConflictResponse
                {
                    Entity = ex.Entity,
                    ExpectedRevision = ex.ExpectedRevision,
                    CurrentRevision = ex.CurrentRevision,
                    Message = ex.Message
                },
                AppJsonContext.Default.ActionGraphConflictResponse,
                statusCode: StatusCodes.Status409Conflict);
        }
    }
}
