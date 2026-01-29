using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

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
