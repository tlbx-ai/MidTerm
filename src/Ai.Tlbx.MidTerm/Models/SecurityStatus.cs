namespace Ai.Tlbx.MidTerm.Models;

/// <summary>
/// Response payload describing the current security status.
/// This is informational only - degraded security does NOT block access.
/// </summary>
public sealed class SecurityStatus
{
    public bool PasswordProtected { get; init; }
    public bool CertificateTrusted { get; init; }
    public List<string> Warnings { get; init; } = [];
}
