using System.Text.Json;
using Ai.Tlbx.Inference;

namespace Ai.Tlbx.MidTerm.Services.Voice;

/// <summary>Orchestration over existing sessions; execution uses the initiating browser's normal control plane.</summary>
internal static class VoiceToolCatalog
{
    internal static readonly IReadOnlyList<ToolDefinition> Tools = [
        Tool("session_overview", "List existing terminal and Agent Controller sessions, IDs, titles, focus and state. Start here before selecting targets.", """
            {"includeBrowserStatus":{"type":"boolean"},"includeRepoStatus":{"type":"boolean"}}
            """),
        Tool("session_activity", "Read current session activity. Agent Controller state comes from its canonical runtime, not terminal scraping.", """
            {"sessionId":{"type":"string"},"tailLines":{"type":"integer","minimum":1,"maximum":200},"activitySeconds":{"type":"integer","minimum":1,"maximum":120}}
            """),
        Tool("read_scrollback", "Read bounded terminal scrollback. For Agent Controller sessions use session_activity instead.", """
            {"sessionId":{"type":"string"},"lines":{"type":"integer","minimum":1,"maximum":200}}
            """, "sessionId"),
        Tool("select_session", "Show an existing session in the initiating browser.", """
            {"sessionId":{"type":"string"},"focusTerminal":{"type":"boolean"}}
            """, "sessionId"),
        Tool("create_session", "Create an ordinary terminal session. This is not the orchestration worker itself.", """
            {"shellType":{"type":"string"},"workingDirectory":{"type":"string"}}
            """),
        Tool("send_prompt", "Send the user's task to an existing terminal agent or Agent Controller through its normal prompt API. Do not interrupt existing work unless requested.", """
            {"sessionId":{"type":"string"},"text":{"type":"string"},"interruptFirst":{"type":"boolean"},"justification":{"type":"string"}}
            """, "sessionId", "text", "justification"),
        Tool("make_input", "Type raw input or key sequences into an ordinary terminal. Requires explicit browser confirmation. Use send_prompt for AI agents.", """
            {"sessionId":{"type":"string"},"text":{"type":"string"},"justification":{"type":"string"}}
            """, "sessionId", "text", "justification"),
        Tool("close_session", "Close a session only when the user requested it. Requires explicit browser confirmation.", """
            {"sessionId":{"type":"string"},"justification":{"type":"string"}}
            """, "sessionId")
    ];

    private static ToolDefinition Tool(string name, string description, string properties, params string[] required)
    {
        using var schema = JsonDocument.Parse("{\"type\":\"object\",\"additionalProperties\":false,\"properties\":" + properties +
            ",\"required\":[" + string.Join(',', required.Select(s => "\"" + s + "\"")) + "]}");
        return new ToolDefinition { Name = name, Description = description, ParametersSchema = schema.RootElement.Clone() };
    }
}
