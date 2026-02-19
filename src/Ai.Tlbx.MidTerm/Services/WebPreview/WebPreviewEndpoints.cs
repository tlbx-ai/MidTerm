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
    }
}
