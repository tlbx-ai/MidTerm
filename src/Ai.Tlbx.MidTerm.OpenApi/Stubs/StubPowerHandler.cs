using Ai.Tlbx.MidTerm.Api.Handlers;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public sealed class StubPowerHandler : IPowerHandler
{
    public IResult Restart() =>
        Results.Ok();

    public IResult Shutdown() =>
        Results.Ok();
}
