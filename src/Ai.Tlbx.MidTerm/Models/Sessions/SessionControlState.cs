using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionControlState
{
    public List<string> AgentControlledSessionIds { get; set; } = [];
    public List<string> LensOnlySessionIds { get; set; } = [];
    public Dictionary<string, string> ProfileHints { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> LensResumeThreadIds { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> SpaceIds { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> WorkspacePaths { get; set; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> Surfaces { get; set; } = new(StringComparer.Ordinal);
}

[JsonSerializable(typeof(SessionControlState))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class SessionControlStateJsonContext : JsonSerializerContext
{
}
