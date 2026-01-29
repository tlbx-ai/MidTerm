using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class SessionEndpointDefinitions
{
    public static IEndpointRouteBuilder MapSessionApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/sessions", (ISessionHandler handler) =>
            handler.GetSessions())
            .Produces<SessionListDto>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/sessions", async (CreateSessionRequest? request, ISessionHandler handler) =>
            await handler.CreateSessionAsync(request))
            .Produces<SessionInfoDto>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/sessions/{id}", async (string id, ISessionHandler handler) =>
            await handler.DeleteSessionAsync(id))
            .Produces(StatusCodes.Status200OK);

        app.MapPost("/api/sessions/{id}/resize", async (string id, ResizeRequest request, ISessionHandler handler) =>
            await handler.ResizeSessionAsync(id, request))
            .Produces<ResizeResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPut("/api/sessions/{id}/name", async (string id, RenameSessionRequest request, ISessionHandler handler, bool auto = false) =>
            await handler.RenameSessionAsync(id, request, auto))
            .Produces(StatusCodes.Status200OK);

        app.MapPost("/api/sessions/{id}/upload", async (string id, IFormFile file, ISessionHandler handler) =>
            await handler.UploadFileAsync(id, file))
            .Produces<FileUploadResponse>(StatusCodes.Status200OK, "application/json")
            .DisableAntiforgery();

        return app;
    }
}
