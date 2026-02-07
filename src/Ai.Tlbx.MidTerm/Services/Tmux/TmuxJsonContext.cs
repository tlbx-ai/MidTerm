using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// AOT-safe JSON serialization context for tmux layout and instruction types.
/// </summary>
[JsonSerializable(typeof(LayoutNode))]
[JsonSerializable(typeof(List<LayoutNode>))]
[JsonSerializable(typeof(TmuxDockInstruction))]
[JsonSerializable(typeof(TmuxFocusInstruction))]
[JsonSerializable(typeof(TmuxSwapInstruction))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class TmuxJsonContext : JsonSerializerContext
{
}

/// <summary>
/// Instruction sent via state WebSocket telling the frontend to dock a new pane.
/// </summary>
public sealed class TmuxDockInstruction
{
    public string Type { get; set; } = "tmux-dock";
    public string NewSessionId { get; set; } = "";
    public string RelativeToSessionId { get; set; } = "";
    public string Position { get; set; } = "";
}

/// <summary>
/// Instruction sent via state WebSocket telling the frontend to focus a session.
/// </summary>
public sealed class TmuxFocusInstruction
{
    public string Type { get; set; } = "tmux-focus";
    public string SessionId { get; set; } = "";
}

/// <summary>
/// Instruction sent via state WebSocket telling the frontend to swap two panes in the layout.
/// </summary>
public sealed class TmuxSwapInstruction
{
    public string Type { get; set; } = "tmux-swap";
    public string SessionIdA { get; set; } = "";
    public string SessionIdB { get; set; } = "";
}
