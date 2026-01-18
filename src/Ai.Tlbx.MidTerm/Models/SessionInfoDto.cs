namespace Ai.Tlbx.MidTerm.Models;

/// <summary>
/// Terminal session information returned by the API.
/// </summary>
public sealed class SessionInfoDto
{
    public string Id { get; set; } = string.Empty;
    public int Pid { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool IsRunning { get; set; }
    public int? ExitCode { get; set; }
    public int Cols { get; set; }
    public int Rows { get; set; }
    public string ShellType { get; set; } = string.Empty;
    public string? Name { get; set; }
    public string? TerminalTitle { get; set; }
    public bool ManuallyNamed { get; set; }
    public string? CurrentDirectory { get; set; }
    public int? ForegroundPid { get; set; }
    public string? ForegroundName { get; set; }
    public string? ForegroundCommandLine { get; set; }
    public int Order { get; set; }
}
