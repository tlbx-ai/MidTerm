namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class InjectGuidanceResponse
{
    public string MidtermDir { get; set; } = "";
    public string MtcliShellPath { get; set; } = "";
    public string MtcliPowerShellPath { get; set; } = "";
    public bool ClaudeMdUpdated { get; set; }
    public bool AgentsMdUpdated { get; set; }
}
