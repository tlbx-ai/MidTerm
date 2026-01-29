using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class EndpointExtensions
{
    public static IEndpointRouteBuilder MapAllApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapAuthApiEndpoints();
        app.MapSessionApiEndpoints();
        app.MapHistoryApiEndpoints();
        app.MapFileApiEndpoints();
        app.MapLogApiEndpoints();
        app.MapSystemApiEndpoints();

        return app;
    }
}
