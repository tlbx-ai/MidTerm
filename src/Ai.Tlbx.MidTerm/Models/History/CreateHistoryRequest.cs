namespace Ai.Tlbx.MidTerm.Models.History;

public sealed class CreateHistoryRequest
{
    public required string ShellType { get; init; }
    public required string Executable { get; init; }
    public string? CommandLine { get; init; }
    public required string WorkingDirectory { get; init; }
    public string? DedupeKey { get; init; }
    public bool IsStarred { get; init; }
    public string? Label { get; init; }
    public string? Notes { get; init; }
    public string LaunchMode { get; init; } = LaunchEntryLaunchModes.Terminal;
    public string? Profile { get; init; }
    public string? LaunchOrigin { get; init; }
    public string SurfaceType { get; init; } = HistorySurfaceTypes.Terminal;
    public string? ForegroundProcessName { get; init; }
    public string? ForegroundProcessCommandLine { get; init; }
    public string? ForegroundProcessDisplayName { get; init; }
    public string? ForegroundProcessIdentity { get; init; }
}
