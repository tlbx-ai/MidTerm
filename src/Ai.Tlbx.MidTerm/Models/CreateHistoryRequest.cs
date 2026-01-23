namespace Ai.Tlbx.MidTerm.Models;

public sealed class CreateHistoryRequest
{
    public required string ShellType { get; init; }
    public required string Executable { get; init; }
    public string? CommandLine { get; init; }
    public required string WorkingDirectory { get; init; }
    public bool IsStarred { get; init; }
}
