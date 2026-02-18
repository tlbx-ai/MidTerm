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

public interface IFileHandler
{
    IResult RegisterPaths(FileRegisterRequest request);
    Task<IResult> CheckPathsAsync(FileCheckRequest request, string? sessionId);
    IResult ListDirectory(string path, string? sessionId);
    IResult ViewFile(string path, string? sessionId);
    IResult DownloadFile(string path, string? sessionId);
    Task<IResult> ResolvePathAsync(string sessionId, string path, bool deep);
}
