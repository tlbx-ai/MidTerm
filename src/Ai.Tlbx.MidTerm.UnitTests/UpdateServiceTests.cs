using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Updates;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class UpdateServiceTests : IDisposable
{
    private const string WindowsAssetName = "mt-win-x64.zip";
    private readonly string _tempDir;

    public UpdateServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_update_tests_{Guid.NewGuid():N}");
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

    public static IEnumerable<object[]> CompareVersionCases()
    {
        yield return ["1.0.0", "1.0.0", 0];
        yield return ["1.0", "1.0.0", 0];
        yield return ["1.2.0", "1.1.9", 1];
        yield return ["2.0.0", "10.0.0", -1];
        yield return ["1.0.0+abc", "1.0.0+def", 0];
        yield return ["1.0.1+abc", "1.0.0+def", 1];
        yield return ["1.0.0", "1.0.0-dev.1", 1];
        yield return ["1.0.0-dev.1", "1.0.0", -1];
        yield return ["1.0.0-dev.10", "1.0.0-dev.2", 1];
        yield return ["1.0.0-dev.2", "1.0.0-dev.10", -1];
        yield return ["1.0.0-DEV.2", "1.0.0-dev.2", 0];
        yield return ["1.0.0-alpha", "1.0.0-beta", -1];
        yield return ["1.0.x", "1.0.0", 0];
        yield return ["1.0.0.1", "1.0.0", 1];
    }

    [Theory]
    [MemberData(nameof(CompareVersionCases))]
    public void CompareVersions_HandlesSemVerAndPrereleaseOrdering(string left, string right, int expectedSign)
    {
        var actual = Math.Sign(UpdateService.CompareVersions(left, right));
        Assert.Equal(expectedSign, actual);
    }

    [Fact]
    public void SelectBestRelease_PicksNewestUsableUpgrade_WhenLatestTagMissingPlatformAsset()
    {
        var releases = new[]
        {
            CreateRelease("v6.10.32-dev.2", prerelease: true, "mt-linux-x64.tar.gz"),
            CreateRelease("v6.10.32-dev.1", prerelease: true, WindowsAssetName),
            CreateRelease("v6.10.31-dev.9", prerelease: true, WindowsAssetName)
        };

        var selection = UpdateService.SelectBestRelease(releases, "dev", "6.10.30-dev.5", WindowsAssetName);

        Assert.NotNull(selection);
        Assert.Equal("v6.10.32-dev.1", selection!.Release.TagName);
        Assert.False(selection.IsDowngrade);
    }

    [Fact]
    public void SelectBestRelease_StableChannelFallsBackToNewestUsableStable_WhenCurrentBuildIsPrerelease()
    {
        var releases = new[]
        {
            CreateRelease("v6.10.33", prerelease: false, "mt-linux-x64.tar.gz"),
            CreateRelease("v6.10.32", prerelease: false, WindowsAssetName),
            CreateRelease("v6.10.34-dev.1", prerelease: true, WindowsAssetName)
        };

        var selection = UpdateService.SelectBestRelease(releases, "stable", "6.10.33-dev.1", WindowsAssetName);

        Assert.NotNull(selection);
        Assert.Equal("v6.10.32", selection!.Release.TagName);
        Assert.True(selection.IsDowngrade);
    }

    [Fact]
    public void SelectBestRelease_DoesNotOfferOlderStableRelease_WhenCurrentBuildIsAlreadyStable()
    {
        var releases = new[]
        {
            CreateRelease("v6.10.33", prerelease: false, "mt-linux-x64.tar.gz"),
            CreateRelease("v6.10.31", prerelease: false, WindowsAssetName)
        };

        var selection = UpdateService.SelectBestRelease(releases, "stable", "6.10.32", WindowsAssetName);

        Assert.Null(selection);
    }

    [Fact]
    public void GetReleaseManifestUrls_PrefersSourceVersionJsonBeforeLegacyRootPath()
    {
        var urls = UpdateService.GetReleaseManifestUrls("v8.6.4-dev");

        Assert.Collection(
            urls,
            url => Assert.Equal(
                "https://raw.githubusercontent.com/tlbx-ai/MidTerm/v8.6.4-dev/src/version.json",
                url),
            url => Assert.Equal(
                "https://raw.githubusercontent.com/tlbx-ai/MidTerm/v8.6.4-dev/version.json",
                url));
    }

    [Fact]
    public void TryReadLocalUpdateInfo_WebOnlyManifest_ReturnsWebOnly()
    {
        var localReleaseDir = Path.Combine(_tempDir, "localrelease");
        Directory.CreateDirectory(localReleaseDir);
        File.WriteAllText(
            Path.Combine(localReleaseDir, "version.json"),
            """
            {
              "web": "8.6.7-dev",
              "pty": "8.3.24",
              "protocol": 1,
              "minCompatiblePty": "2.0.0",
              "webOnly": true
            }
            """);

        var installed = new VersionManifest
        {
            Web = "8.6.6-dev",
            Pty = "8.3.24",
            Protocol = 1,
            MinCompatiblePty = "2.0.0"
        };

        var localUpdate = UpdateService.TryReadLocalUpdateInfo(localReleaseDir, installed, "8.6.6-dev");

        Assert.NotNull(localUpdate);
        Assert.Equal(UpdateType.WebOnly, localUpdate!.Type);
        Assert.Equal("8.6.7-dev", localUpdate.Version);
        Assert.Equal(localReleaseDir, localUpdate.Path);
    }

    [Fact]
    public void TryReadLocalUpdateInfo_PtyChange_ReturnsFull()
    {
        var localReleaseDir = Path.Combine(_tempDir, "localrelease");
        Directory.CreateDirectory(localReleaseDir);
        File.WriteAllText(
            Path.Combine(localReleaseDir, "version.json"),
            """
            {
              "web": "8.6.7-dev",
              "pty": "8.3.25",
              "protocol": 1,
              "minCompatiblePty": "2.0.0",
              "webOnly": false
            }
            """);

        var installed = new VersionManifest
        {
            Web = "8.6.6-dev",
            Pty = "8.3.24",
            Protocol = 1,
            MinCompatiblePty = "2.0.0"
        };

        var localUpdate = UpdateService.TryReadLocalUpdateInfo(localReleaseDir, installed, "8.6.6-dev");

        Assert.NotNull(localUpdate);
        Assert.Equal(UpdateType.Full, localUpdate!.Type);
    }

    [Fact]
    public void TryReadLocalUpdateInfo_ManifestAheadOfBinaryButInstalledManifestAlreadyMatches_ReturnsWebOnly()
    {
        var localReleaseDir = Path.Combine(_tempDir, "localrelease");
        Directory.CreateDirectory(localReleaseDir);
        File.WriteAllText(
            Path.Combine(localReleaseDir, "version.json"),
            """
            {
              "web": "8.6.16-dev",
              "pty": "8.3.24",
              "protocol": 1,
              "minCompatiblePty": "2.0.0",
              "webOnly": true
            }
            """);

        var installed = new VersionManifest
        {
            Web = "8.6.16-dev",
            Pty = "8.3.24",
            Protocol = 1,
            MinCompatiblePty = "2.0.0"
        };

        var localUpdate = UpdateService.TryReadLocalUpdateInfo(localReleaseDir, installed, "8.6.15-dev");

        Assert.NotNull(localUpdate);
        Assert.Equal(UpdateType.WebOnly, localUpdate!.Type);
        Assert.Equal("8.6.16-dev", localUpdate.Version);
    }

    [Fact]
    public void TryReadLocalUpdateInfo_NotNewer_ReturnsNull()
    {
        var localReleaseDir = Path.Combine(_tempDir, "localrelease");
        Directory.CreateDirectory(localReleaseDir);
        File.WriteAllText(
            Path.Combine(localReleaseDir, "version.json"),
            """
            {
              "web": "8.6.6-dev",
              "pty": "8.3.24",
              "protocol": 1,
              "minCompatiblePty": "2.0.0",
              "webOnly": true
            }
            """);

        var installed = new VersionManifest
        {
            Web = "8.6.6-dev",
            Pty = "8.3.24",
            Protocol = 1,
            MinCompatiblePty = "2.0.0"
        };

        var localUpdate = UpdateService.TryReadLocalUpdateInfo(localReleaseDir, installed, "8.6.6-dev");

        Assert.Null(localUpdate);
    }

    [Fact]
    public void ReadUpdateResult_FileMissing_ReturnsNull()
    {
        var result = UpdateService.ReadUpdateResult(_tempDir);
        Assert.Null(result);
    }

    [Fact]
    public void ReadUpdateResult_ValidFile_ReturnsParsedWithFoundTrue()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        var payload = new UpdateResult
        {
            Success = true,
            Message = "done",
            Details = "ok",
            Timestamp = "2026-02-28T00:00:00Z",
            LogFile = "update.log"
        };
        File.WriteAllText(path, JsonSerializer.Serialize(payload, AppJsonContext.Default.UpdateResult));

        var result = UpdateService.ReadUpdateResult(_tempDir);

        Assert.NotNull(result);
        Assert.True(result!.Found);
        Assert.True(result.Success);
        Assert.Equal("done", result.Message);
        Assert.Equal("ok", result.Details);
    }

    [Fact]
    public void ReadUpdateResult_ClearTrue_DeletesResultFile()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        File.WriteAllText(path, "{\"success\":true,\"message\":\"x\"}");

        var result = UpdateService.ReadUpdateResult(_tempDir, clear: true);

        Assert.NotNull(result);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void ReadUpdateResult_InvalidJson_ReturnsNull()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        File.WriteAllText(path, "{ definitely not json");

        var result = UpdateService.ReadUpdateResult(_tempDir);

        Assert.Null(result);
        Assert.True(File.Exists(path));
    }

    [Fact]
    public void ClearUpdateResult_ExistingFile_DeletesIt()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        File.WriteAllText(path, "{\"success\":true}");

        UpdateService.ClearUpdateResult(_tempDir);

        Assert.False(File.Exists(path));
    }

    [Fact]
    public void ClearUpdateResult_MissingFile_DoesNotThrow()
    {
        var exception = Record.Exception(() => UpdateService.ClearUpdateResult(_tempDir));
        Assert.Null(exception);
    }

    private static GitHubRelease CreateRelease(string tagName, bool prerelease, params string[] assetNames)
    {
        return new GitHubRelease
        {
            TagName = tagName,
            Prerelease = prerelease,
            Assets = assetNames.Select(name => new GitHubAsset
            {
                Name = name,
                BrowserDownloadUrl = $"https://example.com/{name}"
            }).ToList()
        };
    }
}
