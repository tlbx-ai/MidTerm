using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface ISessionHandler
{
    IResult GetState();
    IResult GetSessions();
    Task<IResult> CreateSessionAsync(CreateSessionRequest? request);
    IResult ReorderSessions(SessionReorderRequest request);
    Task<IResult> DeleteSessionAsync(string id);
    Task<IResult> ResizeSessionAsync(string id, ResizeRequest request);
    Task<IResult> GetSessionStateAsync(string id, bool includeBuffer, bool includeBufferBase64);
    Task<IResult> SendRawInputAsync(string id, byte[] body);
    Task<IResult> SendTextInputAsync(string id, SessionInputRequest request);
    Task<IResult> GetBufferAsync(string id);
    Task<IResult> GetBufferTextAsync(string id, bool includeBase64);
    Task<IResult> RenameSessionAsync(string id, RenameSessionRequest request, bool auto);
    Task<IResult> UploadFileAsync(string id, IFormFile file);
    Task<IResult> PasteClipboardImageAsync(string id, IFormFile file);
    IResult InjectGuidance(string id);
    IResult SetBookmark(string id, SetBookmarkRequest request);
}
