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

    /// <summary>Signed manifest format. Version 2 binds release metadata and checksums.</summary>
    public int SignatureVersion { get; set; }

    /// <summary>Runtime identifier represented by this archive (for example, win-x64).</summary>
    public string Platform { get; set; } = "";

    /// <summary>Release channel represented by this archive (stable or dev).</summary>
    public string Channel { get; set; } = "";

    /// <summary>
    /// SHA256 checksums of binary files in the authenticated release archive (filename -> hex hash).
    /// For a web-only update, preserved installed host binaries can intentionally differ.
    /// </summary>
    public Dictionary<string, string>? Checksums { get; set; }

    /// <summary>
    /// Transitional ECDSA P-384 signature of the checksums JSON (base64 encoded).
    /// Kept so clients predating signature version 2 can install the migration release.
    /// </summary>
    public string? Signature { get; set; }

    /// <summary>Canonical signed release metadata as base64-encoded UTF-8 JSON.</summary>
    public string? SignedPayload { get; set; }

    /// <summary>ECDSA P-384 signature of <see cref="SignedPayload"/> (base64 encoded).</summary>
    public string? MetadataSignature { get; set; }
}
