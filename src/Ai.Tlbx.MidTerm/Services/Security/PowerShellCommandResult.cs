namespace Ai.Tlbx.MidTerm.Services.Security;

public sealed class PowerShellCommandResult
{
    public int ExitCode { get; init; }
    public string StdOut { get; init; } = "";
    public string StdErr { get; init; } = "";
}
