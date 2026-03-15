namespace Ai.Tlbx.MidTerm.Models.Sessions;

/// <summary>
/// Request payload for toggling agent control on a terminal session.
/// </summary>
public sealed class SetSessionControlRequest
{
    public bool AgentControlled { get; init; }
}
