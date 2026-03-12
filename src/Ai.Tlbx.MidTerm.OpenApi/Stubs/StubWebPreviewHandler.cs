using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.WebPreview;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public sealed class StubWebPreviewHandler : IWebPreviewHandler
{
    public IResult ListPreviewSessions(string sessionId) =>
        Results.Json(new WebPreviewSessionListResponse());

    public IResult EnsurePreviewSession(WebPreviewSessionRequest request) =>
        Results.Json(new WebPreviewSessionInfo { SessionId = request.SessionId ?? "" });

    public IResult DeletePreviewSession(string sessionId, string? previewName) =>
        Results.Ok();

    public IResult GetTarget(string sessionId, string? previewName) =>
        Results.Json(new WebPreviewTargetResponse
        {
            SessionId = sessionId,
            PreviewName = previewName ?? "default"
        });

    public IResult SetTarget(WebPreviewTargetRequest request) =>
        Results.Json(new WebPreviewTargetResponse
        {
            SessionId = request.SessionId,
            PreviewName = request.PreviewName ?? "default",
            Url = request.Url,
            Active = !string.IsNullOrWhiteSpace(request.Url)
        });

    public IResult ClearTarget(string sessionId, string? previewName) =>
        Results.Ok();

    public IResult GetCookies(string sessionId, string? previewName) =>
        Results.Json(new WebPreviewCookiesResponse());

    public IResult SetCookie(string sessionId, string? previewName, WebPreviewCookieSetRequest request) =>
        Results.Json(new WebPreviewCookiesResponse());

    public IResult DeleteCookie(string sessionId, string? previewName, string name, string? path, string? domain) =>
        Results.Json(new WebPreviewCookiesResponse());

    public IResult ClearCookies(string sessionId, string? previewName) =>
        Results.Ok();

    public IResult Reload(WebPreviewReloadRequest request) =>
        Results.Ok();

    public Task<IResult> SnapshotAsync(WebPreviewSnapshotRequest request) =>
        Task.FromResult<IResult>(Results.Json(new WebPreviewSnapshotResponse { SnapshotPath = "/tmp/snapshot" }));

    public IResult GetProxyLog(string sessionId, string? previewName, int? limit) =>
        Results.Json(Array.Empty<WebPreviewProxyLogEntry>());

    public IResult ClearProxyLog(string sessionId, string? previewName) =>
        Results.Ok();
}
