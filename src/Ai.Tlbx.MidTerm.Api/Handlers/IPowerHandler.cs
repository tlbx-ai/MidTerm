using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IPowerHandler
{
    IResult Restart();
    IResult Shutdown();
}
