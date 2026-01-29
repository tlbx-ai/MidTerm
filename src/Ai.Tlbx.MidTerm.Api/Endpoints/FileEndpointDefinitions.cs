using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class FileEndpointDefinitions
{
    public static IEndpointRouteBuilder MapFileApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/files/register", (FileRegisterRequest request, IFileHandler handler) =>
            handler.RegisterPaths(request))
            .Produces(StatusCodes.Status200OK);

        app.MapPost("/api/files/check", async (FileCheckRequest request, IFileHandler handler, string? sessionId) =>
            await handler.CheckPathsAsync(request, sessionId))
            .Produces<FileCheckResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/files/list", (string path, IFileHandler handler, string? sessionId) =>
            handler.ListDirectory(path, sessionId))
            .Produces<DirectoryListResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/files/view", (string path, IFileHandler handler, string? sessionId) =>
            handler.ViewFile(path, sessionId))
            .Produces(StatusCodes.Status200OK);

        app.MapGet("/api/files/download", (string path, IFileHandler handler, string? sessionId) =>
            handler.DownloadFile(path, sessionId))
            .Produces(StatusCodes.Status200OK);

        app.MapGet("/api/files/resolve", async (string sessionId, string path, IFileHandler handler, bool deep = false) =>
            await handler.ResolvePathAsync(sessionId, path, deep))
            .Produces<FileResolveResponse>(StatusCodes.Status200OK, "application/json");

        return app;
    }
}
