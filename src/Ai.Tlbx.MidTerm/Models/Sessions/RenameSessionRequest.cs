namespace Ai.Tlbx.MidTerm.Models.Sessions;

/// <summary>
/// Request payload for renaming a terminal session.
/// </summary>
public sealed class RenameSessionRequest
{
    public string? Name { get; set; }
}
