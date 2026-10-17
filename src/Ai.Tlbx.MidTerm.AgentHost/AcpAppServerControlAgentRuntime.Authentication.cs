using System.Text.Json;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed partial class AcpAppServerControlAgentRuntime
{
    private async Task AuthenticateAcpAsync(JsonElement initializeResult, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_authenticationMethodId)) return;
        if (Traverse(initializeResult, "authMethods") is not { ValueKind: JsonValueKind.Array } methods)
            throw new InvalidOperationException($"{_agentName} did not advertise authentication methods.");
        using var values = methods.EnumerateArray();
        if (!values.Any(method => GetString(method, "id") == _authenticationMethodId))
            throw new InvalidOperationException($"{_agentName} does not support the configured authentication method '{_authenticationMethodId}'.");
        await SendRequestAsync("authenticate", writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("methodId", _authenticationMethodId);
            writer.WriteEndObject();
        }, AttachRequestTimeout, ct).ConfigureAwait(false);
    }
}
