using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IFileHandler
{
    IResult RegisterPaths(FileRegisterRequest request);
    Task<IResult> CheckPathsAsync(FileCheckRequest request, string? sessionId);
    IResult ListDirectory(string path, string? sessionId);
    IResult ViewFile(string path, string? sessionId);
    IResult DownloadFile(string path, string? sessionId);
    Task<IResult> ResolvePathAsync(string sessionId, string path, bool deep);
}
