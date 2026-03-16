using Ai.Tlbx.MidTerm.Api.Handlers;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class PowerEndpointDefinitions
{
    public static IEndpointRouteBuilder MapPowerApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/restart", (IPowerHandler handler) =>
            handler.Restart())
            .Produces(StatusCodes.Status200OK);

        app.MapPost("/api/shutdown", (IPowerHandler handler) =>
            handler.Shutdown())
            .Produces(StatusCodes.Status200OK);

        return app;
    }
}
