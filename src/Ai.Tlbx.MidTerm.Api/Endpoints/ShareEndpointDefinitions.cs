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

        app.MapPost("/api/share/claim", (ClaimShareRequest request, IShareHandler handler) =>
            handler.ClaimShareLink(request))
            .Produces<ClaimShareResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/share/bootstrap", (IShareHandler handler) =>
            handler.GetShareBootstrap())
            .Produces<ShareBootstrapResponse>(StatusCodes.Status200OK, "application/json");

        return app;
    }
}
