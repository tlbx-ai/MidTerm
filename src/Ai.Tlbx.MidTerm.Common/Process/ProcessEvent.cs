namespace Ai.Tlbx.MidTerm.Common.Process;

/// <summary>
/// Information about the current foreground process.
/// </summary>
public sealed class ForegroundProcessInfo
{
    public int Pid { get; init; }
    public string Name { get; init; } = string.Empty;
    public string? CommandLine { get; init; }
    public string? Cwd { get; init; }
}
