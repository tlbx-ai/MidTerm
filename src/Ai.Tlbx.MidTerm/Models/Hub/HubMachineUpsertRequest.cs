using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Hub;

public sealed class HubMachineUpsertRequest
{
    [JsonRequired]
    public string Name { get; set; } = string.Empty;

    [JsonRequired]
    public string BaseUrl { get; set; } = string.Empty;

    [JsonRequired]
    public bool Enabled { get; set; } = true;
    public string? ApiKey { get; set; }
    public string? Password { get; set; }
}
