using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal interface IAppServerControlAgentRuntime : IAsyncDisposable
{
    string Provider { get; }

    Task<HostCommandOutcome> ExecuteAsync(AppServerControlHostCommandEnvelope command, CancellationToken ct);
}

internal sealed class HostCommandOutcome
{
    public required AppServerControlHostCommandResultEnvelope Result { get; init; }

    public IReadOnlyList<AppServerControlProviderEvent> Events { get; init; } = [];
}
