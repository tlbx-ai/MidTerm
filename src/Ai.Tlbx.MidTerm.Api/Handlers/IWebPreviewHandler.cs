using Ai.Tlbx.MidTerm.Models.WebPreview;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IWebPreviewHandler
{
    IResult ListPreviewSessions(string sessionId);
    IResult EnsurePreviewSession(WebPreviewSessionRequest request);
    IResult DeletePreviewSession(string sessionId, string? previewName);
    IResult GetTarget(string sessionId, string? previewName);
    IResult SetTarget(WebPreviewTargetRequest request);
    IResult ClearTarget(string sessionId, string? previewName);
    IResult GetCookies(string sessionId, string? previewName);
    IResult SetCookie(string sessionId, string? previewName, WebPreviewCookieSetRequest request);
    IResult DeleteCookie(string sessionId, string? previewName, string name, string? path, string? domain);
    IResult ClearCookies(string sessionId, string? previewName);
    IResult Reload(WebPreviewReloadRequest request);
    Task<IResult> SnapshotAsync(WebPreviewSnapshotRequest request);
    IResult GetProxyLog(string sessionId, string? previewName, int? limit);
    IResult ClearProxyLog(string sessionId, string? previewName);
}
