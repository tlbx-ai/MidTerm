using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed partial class AcpAppServerControlAgentRuntime
{
    private string? _lastPlanMarkdown;

    private async Task HandleGrokExitPlanModeAsync(JsonElement root, string raw, CancellationToken ct)
    {
        if (!root.TryGetProperty("id", out var rpcId)) return;
        var parameters = Traverse(root, "params");
        if (parameters is { ValueKind: JsonValueKind.Object } wrapper &&
            GetString(wrapper, "method") is "x.ai/exit_plan_mode" or "_x.ai/exit_plan_mode")
            parameters = Traverse(wrapper, "params");

        if (parameters is not { ValueKind: JsonValueKind.Object } payload ||
            !string.Equals(GetString(payload, "sessionId"), _providerThreadId, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(GetString(payload, "toolCallId")) ||
            (payload.TryGetProperty("planContent", out var content) && content.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)))
        {
            await WriteJsonRpcErrorAsync(rpcId.Clone(), -32602, "Invalid Grok plan request.", ct).ConfigureAwait(false);
            return;
        }

        var turnId = _activeTurnId ?? $"acp-plan-proposal:{GetString(payload, "toolCallId")}";
        var markdown = GetString(payload, "planContent")?.Trim();
        if (string.IsNullOrWhiteSpace(markdown)) markdown = _lastPlanMarkdown;
        var hasPlan = !string.IsNullOrWhiteSpace(markdown);
        if (string.IsNullOrWhiteSpace(markdown)) markdown = "No plan was provided.";
        _lastPlanMarkdown = markdown;
        _emit(CreateEvent("plan.completed", turnId, null, null, "acp", GetString(root, "method"), root,
            e => e.PlanCompleted = new AppServerControlProviderPlanCompletedPayload { PlanMarkdown = markdown, IsProposal = hasPlan }, raw));

        // Match the proposed-plan interaction: retain the plan for review and
        // release Grok's native gate without authorizing implementation.
        await WriteJsonLineAsync(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            rpcId.WriteTo(writer);
            writer.WritePropertyName("result");
            writer.WriteStartObject();
            writer.WriteString("outcome", "abandoned");
            writer.WriteString("feedback", "Your plan is saved for review. End this turn without implementing it; await the user's next instruction.");
            writer.WriteEndObject();
            writer.WriteEndObject();
        }, ct).ConfigureAwait(false);
    }
}
