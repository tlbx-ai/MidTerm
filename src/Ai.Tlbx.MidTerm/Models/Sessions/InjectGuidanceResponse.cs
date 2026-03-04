namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class InjectGuidanceResponse
{
    public string MidtermDir { get; set; } = "";
    public bool ClaudeMdUpdated { get; set; }
    public bool AgentsMdUpdated { get; set; }
}
