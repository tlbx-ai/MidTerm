using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Models.Hub;

public sealed class HubMachineState
{
    public HubMachineInfo Machine { get; set; } = new();
    public string Status { get; set; } = "unknown";
    public string? Error { get; set; }
    public bool FingerprintMismatch { get; set; }
    public bool RequiresTrust { get; set; }
    public string? CurrentVersion { get; set; }
    public string? LatestVersion { get; set; }
    public bool UpdateAvailable { get; set; }
    public List<SessionInfoDto> Sessions { get; set; } = [];
}
