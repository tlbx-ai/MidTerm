using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class HistoryEndpointDefinitions
{
    public static IEndpointRouteBuilder MapHistoryApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/history", (IHistoryHandler handler) =>
            handler.GetHistory())
            .Produces<List<LaunchEntry>>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/history", (CreateHistoryRequest request, IHistoryHandler handler) =>
            handler.CreateHistoryEntry(request))
            .Produces<LaunchEntry>(StatusCodes.Status200OK, "application/json");

        app.MapPatch("/api/history/{id}", (string id, HistoryPatchRequest request, IHistoryHandler handler) =>
            handler.PatchHistoryEntry(id, request))
            .Produces<LaunchEntry>(StatusCodes.Status200OK, "application/json");

        app.MapPut("/api/history/{id}/star", (string id, IHistoryHandler handler) =>
            handler.ToggleStar(id))
            .Produces<LaunchEntry>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/history/{id}", (string id, IHistoryHandler handler) =>
            handler.DeleteHistoryEntry(id))
            .Produces(StatusCodes.Status200OK);

        return app;
    }
}
