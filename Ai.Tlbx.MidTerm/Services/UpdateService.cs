using System.Collections.Concurrent;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class UpdateService : IDisposable
{
    private const string RepoOwner = "AiTlbx";
    private const string RepoName = "MidTerm";
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(1);

    private readonly HttpClient _httpClient;
    private readonly ConcurrentDictionary<string, Action<UpdateInfo>> _updateListeners = new();
    private readonly Timer _checkTimer;
    private readonly string _currentVersion;
    private readonly VersionManifest _installedManifest;
    private UpdateInfo? _latestUpdate;
    private bool _disposed;

    public UpdateInfo? LatestUpdate => _latestUpdate;
    public string CurrentVersion => _currentVersion;
    public VersionManifest InstalledManifest => _installedManifest;

    public UpdateService()
    {
        _httpClient = new HttpClient();
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "MidTerm-UpdateCheck");

        _currentVersion = GetCurrentVersion();
        _installedManifest = GetInstalledManifest();
        _checkTimer = new Timer(OnCheckTimer, null, TimeSpan.FromSeconds(10), CheckInterval);
    }

    private static string GetCurrentVersion()
    {
        var version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";

        // Strip git hash suffix (e.g., "2.10.0+abc123" -> "2.10.0")
        var plusIndex = version.IndexOf('+');
        return plusIndex > 0 ? version[..plusIndex] : version;
    }

    private static VersionManifest GetInstalledManifest()
    {
        var version = GetCurrentVersion();

        // Try to read version.json from install directory
        try
        {
            var installDir = Path.GetDirectoryName(GetCurrentBinaryPath());
            if (!string.IsNullOrEmpty(installDir))
            {
                var versionJsonPath = Path.Combine(installDir, "version.json");
                if (File.Exists(versionJsonPath))
                {
                    var json = File.ReadAllText(versionJsonPath);
                    var manifest = JsonSerializer.Deserialize<VersionManifest>(json, VersionManifestContext.Default.VersionManifest);
                    if (manifest is not null)
                    {
                        return manifest;
                    }
                }
            }
        }
        catch
        {
        }

        // Fallback: assume web and pty are same version
        return new VersionManifest
        {
            Web = version,
            Pty = version,
            Protocol = 1,
            MinCompatiblePty = version
        };
    }

    private static UpdateType DetermineUpdateType(VersionManifest installed, VersionManifest release)
    {
        // Protocol change = always full update
        if (release.Protocol != installed.Protocol)
        {
            return UpdateType.Full;
        }

        // PTY version change = full update (host restarts, sessions lost)
        if (!string.Equals(release.Pty, installed.Pty, StringComparison.OrdinalIgnoreCase))
        {
            return UpdateType.Full;
        }

        // Only web version changed = web-only update (sessions preserved)
        if (!string.Equals(release.Web, installed.Web, StringComparison.OrdinalIgnoreCase))
        {
            return UpdateType.WebOnly;
        }

        return UpdateType.None;
    }

    public string AddUpdateListener(Action<UpdateInfo> callback)
    {
        var id = Guid.NewGuid().ToString("N");
        _updateListeners[id] = callback;

        if (_latestUpdate is not null)
        {
            callback(_latestUpdate);
        }

        return id;
    }

    public void RemoveUpdateListener(string id)
    {
        _updateListeners.TryRemove(id, out _);
    }

    private void OnCheckTimer(object? state)
    {
        _ = CheckForUpdateAsync();
    }

    public async Task<UpdateInfo?> CheckForUpdateAsync()
    {
        try
        {
            var apiUrl = $"https://api.github.com/repos/{RepoOwner}/{RepoName}/releases/latest";
            var response = await _httpClient.GetStringAsync(apiUrl);
            var release = JsonSerializer.Deserialize<GitHubRelease>(response, GitHubReleaseContext.Default.GitHubRelease);

            if (release is null || string.IsNullOrEmpty(release.TagName))
            {
                return null;
            }

            var latestVersion = release.TagName.TrimStart('v');

            if (!IsNewerVersion(latestVersion, _currentVersion))
            {
                _latestUpdate = null;
                return null;
            }

            var assetName = GetAssetNameForPlatform();
            var asset = release.Assets?.FirstOrDefault(a => a.Name == assetName);

            var releaseManifest = await FetchReleaseManifestAsync(release.TagName);
            var updateType = DetermineUpdateType(_installedManifest, releaseManifest);

            _latestUpdate = new UpdateInfo
            {
                Available = true,
                CurrentVersion = _currentVersion,
                LatestVersion = latestVersion,
                ReleaseUrl = release.HtmlUrl ?? $"https://github.com/{RepoOwner}/{RepoName}/releases/tag/{release.TagName}",
                DownloadUrl = asset?.BrowserDownloadUrl,
                AssetName = assetName,
                ReleaseNotes = release.Body,
                Type = updateType
            };

            NotifyListeners(_latestUpdate);
            return _latestUpdate;
        }
        catch
        {
            return null;
        }
    }

    private async Task<VersionManifest> FetchReleaseManifestAsync(string tagName)
    {
        try
        {
            var url = $"https://raw.githubusercontent.com/{RepoOwner}/{RepoName}/{tagName}/version.json";
            var json = await _httpClient.GetStringAsync(url);
            var manifest = JsonSerializer.Deserialize<VersionManifest>(json, VersionManifestContext.Default.VersionManifest);
            if (manifest is not null)
            {
                return manifest;
            }
        }
        catch
        {
        }

        var version = tagName.TrimStart('v');
        return new VersionManifest
        {
            Web = version,
            Pty = version,
            Protocol = 1,
            MinCompatiblePty = version
        };
    }

    public async Task<string?> DownloadUpdateAsync(string? downloadUrl = null)
    {
        var url = downloadUrl ?? _latestUpdate?.DownloadUrl;
        if (string.IsNullOrEmpty(url))
        {
            return null;
        }

        try
        {
            var tempDir = Path.Combine(Path.GetTempPath(), $"mt-update-{Guid.NewGuid():N}");
            Directory.CreateDirectory(tempDir);

            var assetName = _latestUpdate?.AssetName ?? GetAssetNameForPlatform();
            var downloadPath = Path.Combine(tempDir, assetName);

            using (var response = await _httpClient.GetAsync(url))
            {
                response.EnsureSuccessStatusCode();
                await using var fs = File.Create(downloadPath);
                await response.Content.CopyToAsync(fs);
            }

            var extractDir = Path.Combine(tempDir, "extracted");
            Directory.CreateDirectory(extractDir);

            if (assetName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            {
                ZipFile.ExtractToDirectory(downloadPath, extractDir);
            }
            else if (assetName.EndsWith(".tar.gz", StringComparison.OrdinalIgnoreCase))
            {
                ExtractTarGz(downloadPath, extractDir);
            }

            return extractDir;
        }
        catch
        {
            return null;
        }
    }

    private static void ExtractTarGz(string archivePath, string extractDir)
    {
        using var fs = File.OpenRead(archivePath);
        using var gzip = new GZipStream(fs, CompressionMode.Decompress);
        using var ms = new MemoryStream();
        gzip.CopyTo(ms);
        ms.Position = 0;

        while (ms.Position < ms.Length)
        {
            var header = new byte[512];
            var read = ms.Read(header, 0, 512);
            if (read < 512 || header[0] == 0)
            {
                break;
            }

            var nameBytes = header[..100];
            var name = System.Text.Encoding.ASCII.GetString(nameBytes).TrimEnd('\0');
            if (string.IsNullOrWhiteSpace(name))
            {
                break;
            }

            var sizeStr = System.Text.Encoding.ASCII.GetString(header[124..136]).TrimEnd('\0', ' ');
            var size = string.IsNullOrEmpty(sizeStr) ? 0L : Convert.ToInt64(sizeStr, 8);

            var filePath = Path.Combine(extractDir, name);
            var typeFlag = header[156];

            if (typeFlag == '5' || name.EndsWith('/'))
            {
                Directory.CreateDirectory(filePath);
            }
            else if (size > 0)
            {
                var dir = Path.GetDirectoryName(filePath);
                if (!string.IsNullOrEmpty(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                var content = new byte[size];
                ms.Read(content, 0, (int)size);
                File.WriteAllBytes(filePath, content);
            }

            var remainder = (int)(512 - (size % 512)) % 512;
            if (remainder > 0)
            {
                ms.Position += remainder;
            }
        }
    }

    public static int CompareVersions(string v1, string v2)
    {
        var v1Clean = v1.Split('+')[0];
        var v2Clean = v2.Split('+')[0];

        var v1Parts = v1Clean.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();
        var v2Parts = v2Clean.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();

        for (var i = 0; i < Math.Max(v1Parts.Length, v2Parts.Length); i++)
        {
            var p1 = i < v1Parts.Length ? v1Parts[i] : 0;
            var p2 = i < v2Parts.Length ? v2Parts[i] : 0;

            if (p1 != p2)
            {
                return p1 - p2;
            }
        }

        return 0;
    }

    private static bool IsNewerVersion(string latest, string current)
    {
        return CompareVersions(latest, current) > 0;
    }

    private static string GetAssetNameForPlatform()
    {
        if (OperatingSystem.IsWindows())
        {
            return "mt-win-x64.zip";
        }

        if (OperatingSystem.IsMacOS())
        {
            return System.Runtime.InteropServices.RuntimeInformation.OSArchitecture ==
                   System.Runtime.InteropServices.Architecture.Arm64
                ? "mt-osx-arm64.tar.gz"
                : "mt-osx-x64.tar.gz";
        }

        return "mt-linux-x64.tar.gz";
    }

    public static string GetCurrentBinaryPath()
    {
        return Environment.ProcessPath ?? AppContext.BaseDirectory;
    }

    private void NotifyListeners(UpdateInfo update)
    {
        foreach (var listener in _updateListeners.Values)
        {
            try
            {
                listener(update);
            }
            catch
            {
            }
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _checkTimer.Dispose();
        _httpClient.Dispose();
        _updateListeners.Clear();
    }
}

public enum UpdateType
{
    None,
    WebOnly,
    Full
}

public sealed class UpdateInfo
{
    public bool Available { get; init; }
    public string CurrentVersion { get; init; } = "";
    public string LatestVersion { get; init; } = "";
    public string ReleaseUrl { get; init; } = "";
    public string? DownloadUrl { get; init; }
    public string? AssetName { get; init; }
    public string? ReleaseNotes { get; init; }
    public UpdateType Type { get; init; } = UpdateType.Full;
    public bool SessionsPreserved => Type == UpdateType.WebOnly;
}

public sealed class VersionManifest
{
    public string Web { get; set; } = "";
    public string Pty { get; set; } = "";
    public int Protocol { get; set; } = 1;
    public string MinCompatiblePty { get; set; } = "";
}

public sealed class UpdateResult
{
    public bool Found { get; set; }
    public bool Success { get; set; }
    public string Message { get; set; } = "";
    public string Details { get; set; } = "";
    public string Timestamp { get; set; } = "";
    public string LogFile { get; set; } = "";
}

internal sealed class GitHubRelease
{
    public string? TagName { get; set; }
    public string? HtmlUrl { get; set; }
    public string? Body { get; set; }
    public List<GitHubAsset>? Assets { get; set; }
}

internal sealed class GitHubAsset
{
    public string? Name { get; set; }
    public string? BrowserDownloadUrl { get; set; }
}
