namespace Ai.Tlbx.MidTerm.Common.Protocol;

public sealed record AcpAgentDefinition(
    string Profile,
    string Name,
    string CommandName,
    IReadOnlyList<string> Arguments);

public static class AcpAgentDefinitions
{
    private static readonly IReadOnlyDictionary<string, AcpAgentDefinition> Definitions =
        new Dictionary<string, AcpAgentDefinition>(StringComparer.Ordinal)
        {
            ["grok"] = new("grok", "Grok Build", "grok", ["agent", "stdio"]),
            ["opencode"] = new("opencode", "OpenCode", "opencode", ["acp"])
        };

    public static IReadOnlyCollection<AcpAgentDefinition> All { get; } = Definitions.Values.ToArray();

    public static bool TryGet(string? profile, out AcpAgentDefinition definition)
    {
        definition = null!;
        return !string.IsNullOrWhiteSpace(profile) &&
               Definitions.TryGetValue(profile.Trim().ToLowerInvariant(), out definition!);
    }
}
