using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class LogEndpointDefinitions
{
    public static IEndpointRouteBuilder MapLogApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/logs/files", (ILogHandler handler) =>
            handler.GetLogFiles())
            .Produces<LogFilesResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/logs/read", (string file, ILogHandler handler, int? lines, bool? fromEnd) =>
            handler.ReadLogFile(file, lines, fromEnd))
            .Produces<LogReadResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/logs/tail", (string file, ILogHandler handler, long? position) =>
            handler.TailLogFile(file, position))
            .Produces<LogReadResponse>(StatusCodes.Status200OK, "application/json");

        return app;
    }
}
