namespace Ai.Tlbx.MidTerm.Models;

public sealed class PathsResponse
{
    public string SettingsFile { get; init; } = "";
    public string SecretsFile { get; init; } = "";
    public string CertificateFile { get; init; } = "";
    public string LogDirectory { get; init; } = "";
}
