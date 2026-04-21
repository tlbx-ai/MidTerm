using System.Security.Cryptography;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services.Updates;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class UpdateVerificationTests : IDisposable
{
    private readonly string _tempDir;

    public UpdateVerificationTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_update_verify_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
        }
    }

    [Fact]
    public void VerifyUpdate_NoChecksums_ReturnsTrueForBackwardCompatibility()
    {
        var manifest = new VersionManifest
        {
            Web = "1.0.0",
            Pty = "1.0.0",
            Protocol = 1,
            Checksums = null
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.True(ok);
    }

    [Fact]
    public void VerifyUpdate_EmptyChecksums_ReturnsTrueEvenWithInvalidSignature()
    {
        var manifest = new VersionManifest
        {
            Web = "1.0.0",
            Pty = "1.0.0",
            Protocol = 1,
            Checksums = [],
            Signature = "not base64"
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.True(ok);
    }

    [Fact]
    public void VerifyUpdate_MatchingChecksums_NoSignature_ReturnsTrue()
    {
        var filePath = Path.Combine(_tempDir, "mt.exe");
        var agentHostPath = Path.Combine(_tempDir, "mtagenthost.exe");
        File.WriteAllText(filePath, "hello update");
        File.WriteAllText(agentHostPath, "agent host update");

        var manifest = new VersionManifest
        {
            Checksums = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["mt.exe"] = ComputeHash(filePath),
                ["mtagenthost.exe"] = ComputeHash(agentHostPath)
            }
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.True(ok);
    }

    [Fact]
    public void VerifyUpdate_MissingExpectedFile_ReturnsFalse()
    {
        var manifest = new VersionManifest
        {
            Checksums = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["missing.bin"] = "abcd"
            }
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.False(ok);
    }

    [Fact]
    public void VerifyUpdate_ChecksumMismatch_ReturnsFalse()
    {
        var filePath = Path.Combine(_tempDir, "version.json");
        File.WriteAllText(filePath, "{\"web\":\"1.0.0\"}");

        var manifest = new VersionManifest
        {
            Checksums = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["version.json"] = "deadbeef"
            }
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.False(ok);
    }

    [Fact]
    public void VerifyUpdate_ChecksumComparison_IsCaseInsensitive()
    {
        var filePath = Path.Combine(_tempDir, "mthost.exe");
        File.WriteAllText(filePath, "host payload");

        var manifest = new VersionManifest
        {
            Checksums = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["mthost.exe"] = ComputeHash(filePath).ToUpperInvariant()
            }
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.True(ok);
    }

    [Fact]
    public void VerifyUpdate_InvalidSignature_ReturnsFalseWhenChecksumsPresent()
    {
        var filePath = Path.Combine(_tempDir, "mt.exe");
        File.WriteAllText(filePath, "signed payload");

        var manifest = new VersionManifest
        {
            Checksums = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["mt.exe"] = ComputeHash(filePath)
            },
            Signature = "definitely-not-base64"
        };

        var ok = UpdateVerification.VerifyUpdate(_tempDir, manifest);

        Assert.False(ok);
    }

    private static string ComputeHash(string filePath)
    {
        using var stream = File.OpenRead(filePath);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
