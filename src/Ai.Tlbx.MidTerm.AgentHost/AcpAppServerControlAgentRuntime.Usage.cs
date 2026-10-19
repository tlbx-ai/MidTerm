using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed partial class AcpAppServerControlAgentRuntime
{
    private AppServerControlUsageSummary? _usage;

    private void HandleUsageUpdate(JsonElement update, JsonElement root, string rawLine)
    {
        var used = ReadUsageCount(update, "used");
        var size = ReadUsageCount(update, "size");
        if (used is null || size is null)
        {
            EmitRuntimeMessage("runtime.notice", "Agent supplied an invalid ACP usage update.", rawLine, timelineVisible: false);
            return;
        }

        var usage = _usage?.Clone() ?? new AppServerControlUsageSummary();
        usage.ContextUsedTokens = used;
        usage.ContextWindowTokens = size;
        var cost = Traverse(update, "cost");
        var currency = GetString(cost, "currency")?.ToUpperInvariant();
        if (cost is { ValueKind: JsonValueKind.Object } costObject &&
            costObject.TryGetProperty("amount", out var amount) && amount.ValueKind == JsonValueKind.Number &&
            amount.TryGetDecimal(out var value) && value >= 0 && currency is { Length: 3 } &&
            currency.All(static character => character is >= 'A' and <= 'Z'))
        {
            usage.CostAmount = value;
            usage.CostCurrency = currency;
        }
        _usage = usage;

        var detail = string.Create(CultureInfo.InvariantCulture, $"{used:N0} / {size:N0} context tokens");
        if (usage.CostAmount is { } costAmount && usage.CostCurrency is { } costCurrency)
            detail += string.Create(CultureInfo.InvariantCulture, $", {costAmount:0.####} {costCurrency} cumulative");

        _emit(CreateEvent("thread.token-usage.updated", _activeTurnId, null, null, "acp", "usage_update", root, e =>
        {
            e.AgentMetadataUpdated = new AppServerControlProviderAgentMetadataPayload { Usage = usage.Clone() };
            e.RuntimeNoticeOnly = new AppServerControlProviderRuntimeMessagePayload
            {
                Message = $"{_agentName} context window updated.",
                Detail = detail
            };
        }, rawLine));
    }

    private static long? ReadUsageCount(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt64(out var count) && count >= 0 ? count : null;
}
