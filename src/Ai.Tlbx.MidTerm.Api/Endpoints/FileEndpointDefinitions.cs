using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
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

        app.MapGet("/api/files/navigation", async (string path, IFileHandler handler, string? sessionId) =>
            await handler.GetNavigationAsync(path, sessionId))
            .Produces<FileNavigationResponse>(StatusCodes.Status200OK, "application/json")
            .Produces<FileDocumentErrorResponse>(StatusCodes.Status403Forbidden);

        app.MapGet("/api/files/view", (string path, IFileHandler handler, string? sessionId) =>
            handler.ViewFile(path, sessionId))
            .Produces(StatusCodes.Status200OK);

        app.MapGet("/api/files/download", (string path, IFileHandler handler, string? sessionId) =>
            handler.DownloadFile(path, sessionId))
            .Produces(StatusCodes.Status200OK);

        app.MapGet("/api/files/resolve", async (string sessionId, string path, IFileHandler handler, bool deep = false) =>
            await handler.ResolvePathAsync(sessionId, path, deep))
            .Produces<FileResolveResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPut("/api/files/save", async (FileSaveRequest request, IFileHandler handler, string? sessionId) =>
            await handler.SaveFileAsync(request, sessionId))
            .Produces<FileSaveResponse>(StatusCodes.Status200OK, "application/json")
            .Produces<FileDocumentErrorResponse>(StatusCodes.Status409Conflict)
            .Produces<FileDocumentErrorResponse>(StatusCodes.Status428PreconditionRequired);

        app.MapGet("/api/files/document", async (string path, IFileHandler handler, string? sessionId, bool full = false, long offset = 0) =>
            await handler.ReadDocumentAsync(path, sessionId, full, offset))
            .Produces<FileDocumentResponse>(StatusCodes.Status200OK, "application/json")
            .Produces<FileDocumentErrorResponse>(StatusCodes.Status403Forbidden)
            .Produces<FileDocumentErrorResponse>(StatusCodes.Status404NotFound)
            .Produces<FileDocumentErrorResponse>(StatusCodes.Status422UnprocessableEntity);

        return app;
    }
}
