using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.Tests;

public sealed class TtyHostSpawnerIntegrityTests
{
    [Fact]
    public void WebOnlyManifest_DoesNotTreatArchiveMthostHashAsInstalledHostHash()
    {
        var manifest = new VersionManifest
        {
            WebOnly = true,
            Checksums = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["mthost.exe"] = "archive-mthost-hash"
            }
        };

        var shouldVerify = TtyHostSpawner.TryGetInstalledMthostChecksum(
            manifest,
            "mthost.exe",
            out var expectedHash);

        Assert.False(shouldVerify);
        Assert.Null(expectedHash);
    }

    [Fact]
    public void FullManifest_UsesAuthenticatedMthostHash()
    {
        var manifest = new VersionManifest
        {
            WebOnly = false,
            Checksums = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["mthost.exe"] = "installed-mthost-hash"
            }
        };

        var shouldVerify = TtyHostSpawner.TryGetInstalledMthostChecksum(
            manifest,
            "mthost.exe",
            out var expectedHash);

        Assert.True(shouldVerify);
        Assert.Equal("installed-mthost-hash", expectedHash);
    }
}
