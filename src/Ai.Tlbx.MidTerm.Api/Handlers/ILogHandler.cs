using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface ILogHandler
{
    IResult GetLogFiles();
    IResult ReadLogFile(string file, int? lines, bool? fromEnd);
    IResult TailLogFile(string file, long? position);
}
