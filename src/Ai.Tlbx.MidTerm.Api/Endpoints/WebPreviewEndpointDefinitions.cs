using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.WebPreview;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class WebPreviewEndpointDefinitions
{
    public static IEndpointRouteBuilder MapWebPreviewApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/webpreview/previews", (string sessionId, IWebPreviewHandler handler) =>
            handler.ListPreviewSessions(sessionId))
            .Produces<WebPreviewSessionListResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/webpreview/previews", (WebPreviewSessionRequest request, IWebPreviewHandler handler) =>
            handler.EnsurePreviewSession(request))
            .Produces<WebPreviewSessionInfo>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/webpreview/previews", (string sessionId, string? previewName, IWebPreviewHandler handler) =>
            handler.DeletePreviewSession(sessionId, previewName))
            .Produces(StatusCodes.Status200OK);

        app.MapGet("/api/webpreview/target", (string sessionId, string? previewName, IWebPreviewHandler handler) =>
            handler.GetTarget(sessionId, previewName))
            .Produces<WebPreviewTargetResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPut("/api/webpreview/target", (WebPreviewTargetRequest request, IWebPreviewHandler handler) =>
            handler.SetTarget(request))
            .Produces<WebPreviewTargetResponse>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/webpreview/target", (string sessionId, string? previewName, IWebPreviewHandler handler) =>
            handler.ClearTarget(sessionId, previewName))
            .Produces(StatusCodes.Status200OK);

        app.MapGet("/api/webpreview/cookies", (string sessionId, string? previewName, IWebPreviewHandler handler) =>
            handler.GetCookies(sessionId, previewName))
            .Produces<WebPreviewCookiesResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/webpreview/cookies", (string sessionId, string? previewName, WebPreviewCookieSetRequest request, IWebPreviewHandler handler) =>
            handler.SetCookie(sessionId, previewName, request))
            .Produces<WebPreviewCookiesResponse>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/webpreview/cookies", (
            string sessionId,
            string? previewName,
            string name,
            string? path,
            string? domain,
            IWebPreviewHandler handler) =>
            handler.DeleteCookie(sessionId, previewName, name, path, domain))
            .Produces<WebPreviewCookiesResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/webpreview/cookies/clear", (string sessionId, string? previewName, IWebPreviewHandler handler) =>
            handler.ClearCookies(sessionId, previewName))
            .Produces(StatusCodes.Status200OK);

        app.MapPost("/api/webpreview/reload", (WebPreviewReloadRequest request, IWebPreviewHandler handler) =>
            handler.Reload(request))
            .Produces(StatusCodes.Status200OK);

        app.MapPost("/api/webpreview/snapshot", async (WebPreviewSnapshotRequest request, IWebPreviewHandler handler) =>
            await handler.SnapshotAsync(request))
            .Produces<WebPreviewSnapshotResponse>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/webpreview/proxylog", (string sessionId, string? previewName, int? limit, IWebPreviewHandler handler) =>
            handler.GetProxyLog(sessionId, previewName, limit))
            .Produces<List<WebPreviewProxyLogEntry>>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/webpreview/proxylog", (string sessionId, string? previewName, IWebPreviewHandler handler) =>
            handler.ClearProxyLog(sessionId, previewName))
            .Produces(StatusCodes.Status200OK);

        return app;
    }
}
