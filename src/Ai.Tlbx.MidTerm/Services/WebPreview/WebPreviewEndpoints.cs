using Ai.Tlbx.MidTerm.Models.WebPreview;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public static class WebPreviewEndpoints
{
    public static void MapWebPreviewEndpoints(WebApplication app, WebPreviewService webPreviewService)
    {
        app.MapGet("/api/webpreview/target", () =>
        {
            var response = new WebPreviewTargetResponse
            {
                Url = webPreviewService.TargetUrl,
                Active = webPreviewService.IsActive
            };
            return Results.Json(response, AppJsonContext.Default.WebPreviewTargetResponse);
        });

        app.MapPut("/api/webpreview/target", (WebPreviewTargetRequest request) =>
        {
            if (!webPreviewService.SetTarget(request.Url))
            {
                return Results.BadRequest("Invalid URL. Must be http:// or https:// and cannot point to this server.");
            }

            var response = new WebPreviewTargetResponse
            {
                Url = webPreviewService.TargetUrl,
                Active = webPreviewService.IsActive
            };
            return Results.Json(response, AppJsonContext.Default.WebPreviewTargetResponse);
        });

        app.MapDelete("/api/webpreview/target", () =>
        {
            webPreviewService.ClearTarget();
            return Results.Ok();
        });

        app.MapGet("/api/webpreview/cookies", () =>
        {
            var response = webPreviewService.GetCookies();
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapPost("/api/webpreview/cookies", (WebPreviewCookieSetRequest request) =>
        {
            if (!webPreviewService.SetCookieFromRaw(request.Raw))
            {
                return Results.BadRequest("Invalid cookie format.");
            }

            var response = webPreviewService.GetCookies();
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapDelete("/api/webpreview/cookies", (string name, string? path, string? domain) =>
        {
            if (!webPreviewService.DeleteCookie(name, path, domain))
            {
                return Results.BadRequest("Failed to delete cookie.");
            }

            var response = webPreviewService.GetCookies();
            return Results.Json(response, AppJsonContext.Default.WebPreviewCookiesResponse);
        });

        app.MapPost("/api/webpreview/reload", (WebPreviewReloadRequest request) =>
        {
            if (request.Mode.Equals("hard", StringComparison.OrdinalIgnoreCase))
            {
                webPreviewService.HardReload();
            }
            return Results.Ok();
        });
    }
}
