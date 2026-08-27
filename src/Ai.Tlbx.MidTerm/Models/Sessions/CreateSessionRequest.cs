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
    public string? SpaceId { get; set; }
    public string? WorkspacePath { get; set; }
    public string? Surface { get; set; }
    /// <summary>
    /// Optional command written to the new PTY as part of session creation.
    /// This keeps bookmark launches atomic and independent of browser WebSocket timing.
    /// </summary>
    public string? LaunchCommand { get; set; }

    /// <summary>
    /// Optional client-generated identifier that makes a session launch safe to
    /// repeat after an HTTP timeout or reconnect. Reusing an identifier with a
    /// different payload is rejected.
    /// </summary>
    public string? LaunchRequestId { get; set; }
}
