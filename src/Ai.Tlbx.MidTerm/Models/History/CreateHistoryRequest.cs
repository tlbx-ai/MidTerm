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
}
