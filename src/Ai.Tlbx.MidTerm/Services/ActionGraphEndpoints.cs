using Ai.Tlbx.MidTerm.Models.ActionGraphs;

namespace Ai.Tlbx.MidTerm.Services;

public static class ActionGraphEndpoints
{
    public static void MapActionGraphEndpoints(WebApplication app, ActionGraphService graphs)
    {
        app.MapGet("/api/graphs", () => Results.Json(
            graphs.ListGraphs(),
            AppJsonContext.Default.ActionGraphListResponse));

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

        app.MapDelete("/api/graphs/{graphId}", (string graphId) => Try(() =>
            graphs.DeleteGraph(graphId) ? Results.Ok() : Results.NotFound()));

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
            graphs.SetNodePosition(graphId, nodeId, request.X, request.Y)
                ? Results.Ok()
                : Results.NotFound()));

        app.MapDelete("/api/graphs/{graphId}/nodes/{nodeId}", (string graphId, string nodeId) => Try(() =>
            graphs.DeleteNode(graphId, nodeId) ? Results.Ok() : Results.NotFound()));

        app.MapPost("/api/graphs/{graphId}/edges", (string graphId, CreateActionGraphEdgeRequest request) =>
            Try(() => Results.Json(
                graphs.CreateEdge(graphId, request),
                AppJsonContext.Default.ActionGraphEdge)));

        app.MapDelete("/api/graphs/{graphId}/edges/{edgeId}", (string graphId, string edgeId) => Try(() =>
            graphs.DeleteEdge(graphId, edgeId) ? Results.Ok() : Results.NotFound()));
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
    }
}
