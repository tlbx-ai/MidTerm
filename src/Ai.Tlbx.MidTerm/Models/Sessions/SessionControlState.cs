using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionControlState
{
    public List<string> AgentControlledSessionIds { get; set; } = [];
}

[JsonSerializable(typeof(SessionControlState))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class SessionControlStateJsonContext : JsonSerializerContext
{
}
