using System.Text.Json;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed partial class AcpAppServerControlAgentRuntime
{
    private void ValidateRequestedConfigValues(IReadOnlyDictionary<string, JsonElement> values)
    {
        foreach (var (id, value) in values)
        {
            var option = FindNativeConfigOption(id);
            var type = GetString(option, "type");
            if (type == "boolean")
            {
                if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    throw new InvalidOperationException($"ACP setting '{id}' requires a boolean value.");
            }
            else if (type == "select")
            {
                if (value.ValueKind != JsonValueKind.String ||
                    !ReadConfigValueOptions(option).Any(candidate => candidate.Value == value.GetString()))
                    throw new InvalidOperationException($"ACP setting '{id}' requires an advertised option value.");
            }
            else
            {
                throw new InvalidOperationException($"ACP setting '{id}' has an unsupported type.");
            }
        }
    }

    private JsonElement FindNativeConfigOption(string id)
    {
        foreach (var option in _quickSettings.ConfigOptions)
        {
            if (string.Equals(GetString(option, "configId") ?? GetString(option, "id"), id, StringComparison.Ordinal))
                return option;
        }
        throw new InvalidOperationException($"{_agentName} does not advertise ACP setting '{id}'.");
    }

    private async Task ApplyRequestedConfigValuesAsync(IReadOnlyDictionary<string, JsonElement> values, CancellationToken ct)
    {
        foreach (var (id, value) in values)
        {
            // Every response is authoritative and may change dependent choices.
            ValidateRequestedConfigValues(new Dictionary<string, JsonElement>(StringComparer.Ordinal) { [id] = value });
            var option = FindNativeConfigOption(id);
            if (option.TryGetProperty("currentValue", out var current) && current.GetRawText() == value.GetRawText())
                continue;
            await SetConfigOptionAsync(id, value, ct).ConfigureAwait(false);
        }
    }
}
