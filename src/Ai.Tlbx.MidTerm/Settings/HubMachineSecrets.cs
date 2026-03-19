namespace Ai.Tlbx.MidTerm.Settings;

public sealed class HubMachineSecrets
{
    public List<HubMachineSecretSettings> Machines { get; set; } = [];
}

public sealed class HubMachineSecretSettings
{
    public string Id { get; set; } = string.Empty;
    public string? ApiKey { get; set; }
    public string? Password { get; set; }
}
