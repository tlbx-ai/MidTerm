using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class LayoutNode
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("direction")]
    public string? Direction { get; set; }

    [JsonPropertyName("children")]
    public List<LayoutNode>? Children { get; set; }
}

public sealed class SessionLayoutState
{
    public long Revision { get; set; }
    public LayoutNode? Root { get; set; }
    public string? FocusedSessionId { get; set; }
}

[JsonSerializable(typeof(SessionLayoutState))]
[JsonSerializable(typeof(LayoutNode))]
[JsonSerializable(typeof(List<LayoutNode>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class SessionLayoutStateJsonContext : JsonSerializerContext
{
}
