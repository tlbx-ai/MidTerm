namespace Ai.Tlbx.MidTerm.Models.Sessions;

/// <summary>
/// Container for a list of terminal sessions.
/// </summary>
public sealed class SessionListDto
{
    public List<SessionInfoDto> Sessions { get; set; } = new();
}
