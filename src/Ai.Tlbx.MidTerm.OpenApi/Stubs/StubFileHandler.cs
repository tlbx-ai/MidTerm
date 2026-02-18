using Ai.Tlbx.MidTerm.Api.Handlers;
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
namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public class StubFileHandler : IFileHandler
{
    public IResult RegisterPaths(FileRegisterRequest request) =>
        Results.Ok();

    public Task<IResult> CheckPathsAsync(FileCheckRequest request, string? sessionId) =>
        Task.FromResult<IResult>(Results.Json(new FileCheckResponse()));

    public IResult ListDirectory(string path, string? sessionId) =>
        Results.Json(new DirectoryListResponse { Path = path });

    public IResult ViewFile(string path, string? sessionId) =>
        Results.Ok();

    public IResult DownloadFile(string path, string? sessionId) =>
        Results.Ok();

    public Task<IResult> ResolvePathAsync(string sessionId, string path, bool deep) =>
        Task.FromResult<IResult>(Results.Json(new FileResolveResponse { Exists = false }));
}
