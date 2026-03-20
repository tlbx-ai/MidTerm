using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Hub;

public sealed class HubMachineSettings
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    [JsonIgnore]
    public string? ApiKey { get; set; }
    [JsonIgnore]
    public string? Password { get; set; }
    public string? LastFingerprint { get; set; }
    public string? PinnedFingerprint { get; set; }
}
