using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public class StubSessionHandler : ISessionHandler
{
    public IResult GetSessions() =>
        Results.Json(new SessionListDto());

    public Task<IResult> CreateSessionAsync(CreateSessionRequest? request) =>
        Task.FromResult<IResult>(Results.Json(new SessionInfoDto { Id = "stub" }));

    public Task<IResult> DeleteSessionAsync(string id) =>
        Task.FromResult<IResult>(Results.Ok());

    public Task<IResult> ResizeSessionAsync(string id, ResizeRequest request) =>
        Task.FromResult<IResult>(Results.Json(new ResizeResponse { Accepted = true }));

    public Task<IResult> RenameSessionAsync(string id, RenameSessionRequest request, bool auto) =>
        Task.FromResult<IResult>(Results.Ok());

    public Task<IResult> UploadFileAsync(string id, IFormFile file) =>
        Task.FromResult<IResult>(Results.Json(new FileUploadResponse { Path = "/tmp/file" }));
}
