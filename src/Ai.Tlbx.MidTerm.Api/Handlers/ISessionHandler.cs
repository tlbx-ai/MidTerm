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
    IResult GetSessions();
    Task<IResult> CreateSessionAsync(CreateSessionRequest? request);
    Task<IResult> DeleteSessionAsync(string id);
    Task<IResult> ResizeSessionAsync(string id, ResizeRequest request);
    Task<IResult> RenameSessionAsync(string id, RenameSessionRequest request, bool auto);
    Task<IResult> UploadFileAsync(string id, IFormFile file);
    IResult SetBookmark(string id, SetBookmarkRequest request);
}
