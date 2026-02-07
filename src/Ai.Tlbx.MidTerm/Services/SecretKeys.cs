namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Well-known keys for secret storage.
/// </summary>
public static class SecretKeys
{
    public const string SessionSecret = "midterm.session_secret";
    public const string PasswordHash = "midterm.password_hash";
    public const string CertificatePassword = "midterm.certificate_password";
    public const string VoiceServerPassword = "midterm.voice_server_password";
}
