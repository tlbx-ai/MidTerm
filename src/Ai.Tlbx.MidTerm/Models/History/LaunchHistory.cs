using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.History;

public sealed class LaunchEntry
{
    public string Id { get; set; } = "";
    public string ShellType { get; set; } = "";
    public string Executable { get; set; } = "";
    public string? CommandLine { get; set; }
    public string WorkingDirectory { get; set; } = "";
    public bool IsStarred { get; set; }
    public string? Label { get; set; }
    public DateTime LastUsed { get; set; }
    public int Order { get; set; }
}

public sealed class HistoryReorderRequest
{
    public required List<string> OrderedIds { get; init; }
}

public sealed class LaunchHistory
{
    public List<LaunchEntry> Entries { get; set; } = [];
}

[JsonSerializable(typeof(LaunchEntry))]
[JsonSerializable(typeof(LaunchHistory))]
[JsonSerializable(typeof(List<LaunchEntry>))]
[JsonSerializable(typeof(HistoryReorderRequest))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class HistoryJsonContext : JsonSerializerContext
{
}
