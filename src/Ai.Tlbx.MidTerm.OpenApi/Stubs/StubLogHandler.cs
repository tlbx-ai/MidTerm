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

public class StubLogHandler : ILogHandler
{
    public IResult GetLogFiles() =>
        Results.Json(new LogFilesResponse());

    public IResult ReadLogFile(string file, int? lines, bool? fromEnd) =>
        Results.Json(new LogReadResponse { FileName = file });

    public IResult TailLogFile(string file, long? position) =>
        Results.Json(new LogReadResponse { FileName = file });
}
