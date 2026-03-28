namespace Ai.Tlbx.MidTerm.Models.Update;

/// <summary>
/// Version manifest describing component versions and protocol compatibility.
/// </summary>
public sealed class VersionManifest
{
    /// <summary>Web server version.</summary>
    public string Web { get; set; } = "";
    /// <summary>PTY host version.</summary>
    public string Pty { get; set; } = "";
    /// <summary>Protocol version for web-to-PTY communication.</summary>
    public int Protocol { get; set; } = 1;
    /// <summary>Minimum compatible PTY version for web-only updates.</summary>
    public string MinCompatiblePty { get; set; } = "";
    /// <summary>Whether the signed updater should preserve the installed mthost binary.</summary>
    public bool WebOnly { get; set; }

    /// <summary>SHA256 checksums of binary files (filename -> hex hash).</summary>
    public Dictionary<string, string>? Checksums { get; set; }

    /// <summary>Ed25519 signature of the checksums JSON (base64 encoded).</summary>
    public string? Signature { get; set; }
}
