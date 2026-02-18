using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Update;

namespace Ai.Tlbx.MidTerm.Services.Updates;

/// <summary>
/// Verifies update integrity using SHA256 checksums and ECDSA P-384 signatures.
/// </summary>
public static class UpdateVerification
{
    // ECDSA P-384 public key for verifying release signatures (base64 encoded SPKI format)
    private const string PublicKeyBase64 = "MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE9txOtWhrtgO7q8Hlpe7tzv8ARMHaLYpO1JFm9psIc6LyBMLgwgz0GXfL+kU7iDVK0GyE6q2nsz7AEhKfwfbQY7d+k/WKPDEvV6OzYIYStxW4v2mAKNY1XHyuOntapcb/";

    /// <summary>
    /// Verifies the integrity of extracted update files.
    /// </summary>
    /// <param name="extractDir">Directory containing extracted update files</param>
    /// <param name="manifest">Version manifest with checksums and signature</param>
    /// <returns>True if verification passes, false otherwise</returns>
    public static bool VerifyUpdate(string extractDir, VersionManifest manifest)
    {
        // If no checksums present, skip verification (backward compatibility with unsigned releases)
        if (manifest.Checksums is null || manifest.Checksums.Count == 0)
        {
            Log.Info(() => "UpdateVerification: No checksums in manifest, skipping verification (unsigned release)");
            return true;
        }

        // Verify signature if present
        if (!string.IsNullOrEmpty(manifest.Signature))
        {
            if (!VerifySignature(manifest))
            {
                Log.Warn(() => "UpdateVerification: Signature verification failed - update rejected");
                return false;
            }
            Log.Info(() => "UpdateVerification: Signature verified successfully");
        }
        else
        {
            // Checksums without signature - still verify checksums but warn
            Log.Warn(() => "UpdateVerification: Checksums present but no signature - verifying checksums only");
        }

        // Verify each file's checksum
        foreach (var (filename, expectedHash) in manifest.Checksums)
        {
            var filePath = Path.Combine(extractDir, filename);
            if (!File.Exists(filePath))
            {
                Log.Warn(() => $"UpdateVerification: Expected file not found: {filename}");
                return false;
            }

            var actualHash = ComputeFileHash(filePath);
            if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
            {
                Log.Warn(() => $"UpdateVerification: Checksum mismatch for {filename}: expected {expectedHash}, got {actualHash}");
                return false;
            }

            Log.Info(() => $"UpdateVerification: Checksum verified: {filename}");
        }

        return true;
    }

    /// <summary>
    /// Verifies the ECDSA signature of the manifest checksums.
    /// </summary>
    private static bool VerifySignature(VersionManifest manifest)
    {
        // Check if public key is configured (placeholder means not yet set up)
        if (PublicKeyBase64.StartsWith("PLACEHOLDER", StringComparison.Ordinal))
        {
            Log.Warn(() => "UpdateVerification: Public key not configured, signature verification skipped");
            return true;
        }

        try
        {
            var publicKeyBytes = Convert.FromBase64String(PublicKeyBase64);
            var signatureBytes = Convert.FromBase64String(manifest.Signature!);

            // Create the message to verify: sorted JSON of checksums (deterministic)
            var checksumJson = SerializeChecksumsForSigning(manifest.Checksums!);
            var messageBytes = Encoding.UTF8.GetBytes(checksumJson);

            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(publicKeyBytes, out _);
            return ecdsa.VerifyData(messageBytes, signatureBytes, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        }
        catch (Exception ex)
        {
            Log.Exception(ex, "UpdateVerification.VerifySignature");
            return false;
        }
    }

    /// <summary>
    /// Computes SHA256 hash of a file.
    /// </summary>
    private static string ComputeFileHash(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        var hash = SHA256.HashData(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    /// <summary>
    /// Serializes checksums to a deterministic JSON string for signature verification.
    /// Uses manual JSON building to avoid AOT serialization issues.
    /// </summary>
    private static string SerializeChecksumsForSigning(Dictionary<string, string> checksums)
    {
        // Sort by key for deterministic output
        var sorted = checksums.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToList();

        // Build JSON manually to avoid AOT issues
        var sb = new StringBuilder("{");
        for (var i = 0; i < sorted.Count; i++)
        {
            if (i > 0)
            {
                sb.Append(',');
            }
            sb.Append('"');
            sb.Append(JsonEncodedText.Encode(sorted[i].Key));
            sb.Append("\":\"");
            sb.Append(JsonEncodedText.Encode(sorted[i].Value));
            sb.Append('"');
        }
        sb.Append('}');
        return sb.ToString();
    }
}
