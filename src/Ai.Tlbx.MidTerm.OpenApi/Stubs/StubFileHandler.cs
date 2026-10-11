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
    public Task<IResult> ExecuteOperationAsync(FileOperationRequest request, string sessionId) => Task.FromResult<IResult>(Results.Json(new FileOperationResponse()));
    public IResult GetOperation(string id, string sessionId) => Results.Json(new FileOperationResponse());
    public IResult GetRecovery(string directory, string sessionId, string? cursor) => Results.Json(new FileRecoveryResponse());
    public Task<IResult> RestoreAsync(FileRestoreRequest request, string sessionId) => Task.FromResult<IResult>(Results.Json(new FileOperationItem()));
    public IResult RegisterPaths(FileRegisterRequest request) =>
        Results.Ok();

    public Task<IResult> CheckPathsAsync(FileCheckRequest request, string? sessionId) =>
        Task.FromResult<IResult>(Results.Json(new FileCheckResponse()));

    public IResult ListDirectory(string path, string? sessionId, bool showHidden, bool showIgnored) =>
        Results.Json(new DirectoryListResponse { Path = path });

    public Task<IResult> GetNavigationAsync(string path, string? sessionId) =>
        Task.FromResult<IResult>(Results.Json(new FileNavigationResponse { Path = path }));

    public IResult ViewFile(string path, string? sessionId) =>
        Results.Ok();

    public IResult DownloadFile(string path, string? sessionId) =>
        Results.Ok();

    public Task<IResult> ResolvePathAsync(string sessionId, string path, bool deep) =>
        Task.FromResult<IResult>(Results.Json(new FileResolveResponse { Exists = false }));

    public Task<IResult> SaveFileAsync(FileSaveRequest request, string? sessionId) =>
        Task.FromResult<IResult>(Results.Json(new FileSaveResponse { Success = true, Size = 0 }));

    public Task<IResult> ReadDocumentAsync(string path, string? sessionId, bool full, long offset) =>
        Task.FromResult<IResult>(Results.Json(new FileDocumentResponse { Path = path }));
}
