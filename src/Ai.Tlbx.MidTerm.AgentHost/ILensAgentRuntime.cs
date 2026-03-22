using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal interface ILensAgentRuntime : IAsyncDisposable
{
    string Provider { get; }

    Task<HostCommandOutcome> ExecuteAsync(LensHostCommandEnvelope command, CancellationToken ct);
}

internal sealed class HostCommandOutcome
{
    public required LensHostCommandResultEnvelope Result { get; init; }

    public IReadOnlyList<LensHostEventEnvelope> Events { get; init; } = [];
}
