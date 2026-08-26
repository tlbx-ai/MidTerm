namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class AgentControllerInstallationDto
{
    public string Profile { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Protocol { get; set; } = string.Empty;
    public string Command { get; set; } = string.Empty;
    public bool SupportsResume { get; set; }
}
