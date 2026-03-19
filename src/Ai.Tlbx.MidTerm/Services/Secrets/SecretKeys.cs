namespace Ai.Tlbx.MidTerm.Services.Secrets;

/// <summary>
/// Well-known keys for secret storage.
/// </summary>
public static class SecretKeys
{
    public const string SessionSecret = "midterm.session_secret";
    public const string PasswordHash = "midterm.password_hash";
    public const string CertificatePassword = "midterm.certificate_password";
    public const string VoiceServerPassword = "midterm.voice_server_password";
    public const string ApiKeys = "midterm.api_keys";
    public const string HubMachineSecrets = "midterm.hub_machine_secrets";
}
