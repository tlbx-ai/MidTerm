using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.Share;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class ShareEndpointDefinitions
{
    public static IEndpointRouteBuilder MapShareApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/share/create", (CreateShareLinkRequest request, IShareHandler handler) =>
            handler.CreateShareLink(request))
            .Produces<CreateShareLinkResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/share/active", (int? limit, IShareHandler handler) =>
            handler.GetActiveShares(limit))
            .Produces<ActiveShareGrantListResponse>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/share/{grantId}", (string grantId, IShareHandler handler) =>
            handler.RevokeShare(grantId))
            .Produces(StatusCodes.Status204NoContent)
            .Produces(StatusCodes.Status404NotFound);

        app.MapPost("/api/share/claim", (ClaimShareRequest request, IShareHandler handler) =>
            handler.ClaimShareLink(request))
            .Produces<ClaimShareResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/share/bootstrap", (IShareHandler handler) =>
            handler.GetShareBootstrap())
            .Produces<ShareBootstrapResponse>(StatusCodes.Status200OK, "application/json");

        return app;
    }
}
