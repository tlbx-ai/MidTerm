namespace Ai.Tlbx.MidTerm.Models.Hub;

public sealed class HubMachineInfo
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public bool HasApiKey { get; set; }
    public bool HasPassword { get; set; }
    public string? LastFingerprint { get; set; }
    public string? PinnedFingerprint { get; set; }
}
