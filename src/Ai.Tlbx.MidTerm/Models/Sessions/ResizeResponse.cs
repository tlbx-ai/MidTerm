namespace Ai.Tlbx.MidTerm.Models.Sessions;

/// <summary>
/// Response payload after resizing a terminal session.
/// </summary>
public sealed class ResizeResponse
{
    public bool Accepted { get; set; }
    public int Cols { get; set; }
    public int Rows { get; set; }
}
