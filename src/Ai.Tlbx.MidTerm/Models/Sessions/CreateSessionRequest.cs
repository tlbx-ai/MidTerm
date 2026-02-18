namespace Ai.Tlbx.MidTerm.Models.Sessions;

/// <summary>
/// Request payload for creating a new terminal session.
/// </summary>
public sealed class CreateSessionRequest
{
    public int Cols { get; set; } = 120;
    public int Rows { get; set; } = 30;
    public string? Shell { get; set; }
    public string? WorkingDirectory { get; set; }
}
