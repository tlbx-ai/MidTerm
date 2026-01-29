using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface ISessionHandler
{
    IResult GetSessions();
    Task<IResult> CreateSessionAsync(CreateSessionRequest? request);
    Task<IResult> DeleteSessionAsync(string id);
    Task<IResult> ResizeSessionAsync(string id, ResizeRequest request);
    Task<IResult> RenameSessionAsync(string id, RenameSessionRequest request, bool auto);
    Task<IResult> UploadFileAsync(string id, IFormFile file);
}
