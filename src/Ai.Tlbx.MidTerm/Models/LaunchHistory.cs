using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models;

public sealed class LaunchEntry
{
    public string Id { get; set; } = "";
    public string ShellType { get; set; } = "";
    public string Executable { get; set; } = "";
    public string? CommandLine { get; set; }
    public string WorkingDirectory { get; set; } = "";
    public bool IsStarred { get; set; }
    public string? Label { get; set; }
    public int Weight { get; set; } = 1;
    public DateTime LastUsed { get; set; }
}

public sealed class LaunchHistory
{
    public List<LaunchEntry> Entries { get; set; } = [];
}

[JsonSerializable(typeof(LaunchEntry))]
[JsonSerializable(typeof(LaunchHistory))]
[JsonSerializable(typeof(List<LaunchEntry>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
public partial class HistoryJsonContext : JsonSerializerContext
{
}
