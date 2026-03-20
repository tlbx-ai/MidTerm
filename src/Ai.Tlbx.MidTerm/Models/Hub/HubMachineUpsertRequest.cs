namespace Ai.Tlbx.MidTerm.Models.Hub;

public sealed class HubMachineUpsertRequest
{
    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public string? ApiKey { get; set; }
    public string? Password { get; set; }
}
