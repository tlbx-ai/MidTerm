using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionControlState
{
    public List<string> AgentControlledSessionIds { get; set; } = [];
    public List<string> LensOnlySessionIds { get; set; } = [];
    public Dictionary<string, string> ProfileHints { get; set; } = new(StringComparer.Ordinal);
}

[JsonSerializable(typeof(SessionControlState))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class SessionControlStateJsonContext : JsonSerializerContext
{
}
