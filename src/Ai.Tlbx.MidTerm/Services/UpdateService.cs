using System.Collections.Concurrent;
using System.IO.Compression;
using System.Reflection;
using System.Security;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class UpdateService : IDisposable
{
    private const string RepoOwner = "tlbx-ai";
    private const string RepoName = "MidTerm";
    private const string DevEnvironmentName = "THELAIR";

    // Dev-only local update path - uses secure ProgramData folder instead of world-writable temp
    private static string LocalReleasePath => OperatingSystem.IsWindows()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "MidTerm", "localrelease")
        : Path.Combine("/var/lib/midterm", "localrelease");
    private static readonly TimeSpan CheckInterval = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan DevCheckInterval = TimeSpan.FromMinutes(2);

    private readonly HttpClient _httpClient;
    private readonly SettingsService _settingsService;
    private readonly ConcurrentDictionary<string, Action<UpdateInfo>> _updateListeners = new();
    private readonly Timer _checkTimer;
    private readonly string _currentVersion;
    private readonly VersionManifest _installedManifest;
    private UpdateInfo? _latestUpdate;
    private bool _disposed;

    public UpdateInfo? LatestUpdate => _latestUpdate;
    public string CurrentVersion => _currentVersion;
    public VersionManifest InstalledManifest => _installedManifest;

    public UpdateService() : this(new SettingsService())
    {
    }

    public UpdateService(SettingsService settingsService)
    {
        _settingsService = settingsService;
        _httpClient = new HttpClient();
        _httpClient.DefaultRequestHeaders.Add("User-Agent", "MidTerm-UpdateCheck");

        _currentVersion = GetCurrentVersion();
        _installedManifest = GetInstalledManifest();
        var interval = IsDevEnvironment ? DevCheckInterval : CheckInterval;
        _checkTimer = new Timer(OnCheckTimer, null, TimeSpan.FromSeconds(10), interval);
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
        // Use permissive MinCompatiblePty to avoid killing sessions when version.json is missing (dev)
        return new VersionManifest
        {
            Web = version,
            Pty = version,
            Protocol = 1,
            MinCompatiblePty = "2.0.0"
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
            var devEnv = GetDevEnvironment();
            var updateChannel = _settingsService.Load().UpdateChannel;

            GitHubRelease? release;
            if (updateChannel == "dev")
            {
                release = await FetchLatestDevReleaseAsync();
            }
            else
            {
                var apiUrl = $"https://api.github.com/repos/{RepoOwner}/{RepoName}/releases/latest";
                var response = await _httpClient.GetStringAsync(apiUrl);
                release = JsonSerializer.Deserialize<GitHubRelease>(response, GitHubReleaseContext.Default.GitHubRelease);
            }

            if (release is null || string.IsNullOrEmpty(release.TagName))
            {
                return null;
            }

            var latestVersion = release.TagName.TrimStart('v');
            var comparison = CompareVersions(latestVersion, _currentVersion);

            // For stable channel on a dev version, offer downgrade to stable
            var isDowngrade = updateChannel == "stable" && comparison < 0;

            if (comparison <= 0 && !isDowngrade)
            {
                // No GitHub update, but check for local update in dev mode
                if (devEnv is not null)
                {
                    var localUpdateOnly = CheckLocalUpdate();
                    if (localUpdateOnly is not null)
                    {
                        _latestUpdate = new UpdateInfo
                        {
                            Available = false,
                            CurrentVersion = _currentVersion,
                            LatestVersion = _currentVersion,
                            ReleaseUrl = "",
                            Environment = devEnv,
                            LocalUpdate = localUpdateOnly
                        };
                        NotifyListeners(_latestUpdate);
                        return _latestUpdate;
                    }
                }
                _latestUpdate = null;
                return null;
            }

            var assetName = GetAssetNameForPlatform();
            var asset = release.Assets?.FirstOrDefault(a => a.Name == assetName);

            var releaseManifest = await FetchReleaseManifestAsync(release.TagName);
            var updateType = DetermineUpdateType(_installedManifest, releaseManifest);

            var localUpdate = devEnv is not null ? CheckLocalUpdate() : null;

            _latestUpdate = new UpdateInfo
            {
                Available = true,
                CurrentVersion = _currentVersion,
                LatestVersion = latestVersion,
                ReleaseUrl = release.HtmlUrl ?? $"https://github.com/{RepoOwner}/{RepoName}/releases/tag/{release.TagName}",
                DownloadUrl = asset?.BrowserDownloadUrl,
                AssetName = assetName,
                ReleaseNotes = release.Body,
                Type = updateType,
                Environment = devEnv,
                LocalUpdate = localUpdate,
                IsDowngrade = isDowngrade
            };

            NotifyListeners(_latestUpdate);
            return _latestUpdate;
        }
        catch
        {
            // If GitHub check fails but we're in dev mode, still return local update info
            var devEnv = GetDevEnvironment();
            if (devEnv is not null)
            {
                var localUpdate = CheckLocalUpdate();
                if (localUpdate is not null)
                {
                    _latestUpdate = new UpdateInfo
                    {
                        Available = false,
                        CurrentVersion = _currentVersion,
                        LatestVersion = _currentVersion,
                        ReleaseUrl = "",
                        Environment = devEnv,
                        LocalUpdate = localUpdate
                    };
                    NotifyListeners(_latestUpdate);
                    return _latestUpdate;
                }
            }
            return null;
        }
    }

    private async Task<GitHubRelease?> FetchLatestDevReleaseAsync()
    {
        var apiUrl = $"https://api.github.com/repos/{RepoOwner}/{RepoName}/releases?per_page=50";
        var response = await _httpClient.GetStringAsync(apiUrl);
        var releases = JsonSerializer.Deserialize<List<GitHubRelease>>(response, GitHubReleaseContext.Default.ListGitHubRelease);

        if (releases is null || releases.Count == 0)
        {
            return null;
        }

        // Find the highest version (including prereleases)
        GitHubRelease? best = null;
        foreach (var release in releases)
        {
            if (string.IsNullOrEmpty(release.TagName))
            {
                continue;
            }

            if (best is null)
            {
                best = release;
                continue;
            }

            var bestVersion = best.TagName!.TrimStart('v');
            var currentVersion = release.TagName!.TrimStart('v');

            if (CompareVersions(currentVersion, bestVersion) > 0)
            {
                best = release;
            }
        }

        return best;
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

    private LocalUpdateInfo? CheckLocalUpdate()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var versionJsonPath = Path.Combine(LocalReleasePath, "version.json");
        if (!File.Exists(versionJsonPath))
        {
            return null;
        }

        try
        {
            var json = File.ReadAllText(versionJsonPath);
            var manifest = JsonSerializer.Deserialize<VersionManifest>(json, VersionManifestContext.Default.VersionManifest);
            if (manifest is null)
            {
                return null;
            }

            if (!IsNewerVersion(manifest.Web, _currentVersion))
            {
                return null;
            }

            var updateType = DetermineUpdateType(_installedManifest, manifest);

            return new LocalUpdateInfo
            {
                Available = true,
                Version = manifest.Web,
                Path = LocalReleasePath,
                Type = updateType
            };
        }
        catch
        {
            return null;
        }
    }

    private static string? GetDevEnvironment()
    {
        var env = System.Environment.GetEnvironmentVariable("MIDTERM_ENVIRONMENT");
        return env == DevEnvironmentName ? env : null;
    }

    public static bool IsDevEnvironment => GetDevEnvironment() is not null;

    public string? GetLocalUpdatePath()
    {
        if (!IsDevEnvironment || !OperatingSystem.IsWindows())
        {
            return null;
        }

        var versionJsonPath = Path.Combine(LocalReleasePath, "version.json");
        if (!File.Exists(versionJsonPath))
        {
            return null;
        }

        // Verify mt.exe and mthost.exe exist
        var mtPath = Path.Combine(LocalReleasePath, "mt.exe");
        var mthostPath = Path.Combine(LocalReleasePath, "mthost.exe");
        if (!File.Exists(mtPath) || !File.Exists(mthostPath))
        {
            return null;
        }

        return LocalReleasePath;
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

            // Verify update integrity using checksums and signature from version.json
            var manifestPath = Path.Combine(extractDir, "version.json");
            if (File.Exists(manifestPath))
            {
                var manifestJson = await File.ReadAllTextAsync(manifestPath);
                var manifest = JsonSerializer.Deserialize<VersionManifest>(manifestJson, VersionManifestContext.Default.VersionManifest);
                if (manifest is not null && !UpdateVerification.VerifyUpdate(extractDir, manifest))
                {
                    // Verification failed - clean up and reject update
                    try { Directory.Delete(tempDir, true); } catch { }
                    return null;
                }
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

            // Security: Validate path stays within extract directory (prevent path traversal)
            var fullPath = Path.GetFullPath(filePath);
            var fullExtractDir = Path.GetFullPath(extractDir);
            if (!fullPath.StartsWith(fullExtractDir + Path.DirectorySeparatorChar) &&
                fullPath != fullExtractDir)
            {
                throw new SecurityException($"Path traversal detected in archive: {name}");
            }

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
        // Strip build metadata (e.g., +abc123)
        var v1Clean = v1.Split('+')[0];
        var v2Clean = v2.Split('+')[0];

        // Parse version and prerelease (e.g., "6.10.30-dev.1" -> base="6.10.30", pre="dev.1")
        var (v1Base, v1Pre) = ParseVersionWithPrerelease(v1Clean);
        var (v2Base, v2Pre) = ParseVersionWithPrerelease(v2Clean);

        // Compare base versions first
        var baseCompare = CompareBaseVersions(v1Base, v2Base);
        if (baseCompare != 0)
        {
            return baseCompare;
        }

        // Same base version - compare prereleases
        // Stable (no prerelease) beats any prerelease
        if (v1Pre is null && v2Pre is not null)
        {
            return 1;  // v1 is stable, v2 is prerelease -> v1 wins
        }
        if (v1Pre is not null && v2Pre is null)
        {
            return -1; // v1 is prerelease, v2 is stable -> v2 wins
        }
        if (v1Pre is null && v2Pre is null)
        {
            return 0;  // Both stable
        }

        // Both have prereleases - compare them (e.g., dev.5 > dev.4)
        return ComparePrereleases(v1Pre!, v2Pre!);
    }

    private static (string baseVersion, string? prerelease) ParseVersionWithPrerelease(string version)
    {
        var dashIndex = version.IndexOf('-');
        if (dashIndex < 0)
        {
            return (version, null);
        }
        return (version[..dashIndex], version[(dashIndex + 1)..]);
    }

    private static int CompareBaseVersions(string v1, string v2)
    {
        var v1Parts = v1.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();
        var v2Parts = v2.Split('.').Select(s => int.TryParse(s, out var n) ? n : 0).ToArray();

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

    private static int ComparePrereleases(string pre1, string pre2)
    {
        // Format: "dev.N" - extract the numeric part
        var match1 = Regex.Match(pre1, @"\.(\d+)$");
        var match2 = Regex.Match(pre2, @"\.(\d+)$");

        if (match1.Success && match2.Success)
        {
            var num1 = int.Parse(match1.Groups[1].Value);
            var num2 = int.Parse(match2.Groups[1].Value);
            return num1 - num2;
        }

        // Fallback to string comparison
        return string.Compare(pre1, pre2, StringComparison.OrdinalIgnoreCase);
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

internal sealed class GitHubRelease
{
    public string? TagName { get; set; }
    public string? HtmlUrl { get; set; }
    public string? Body { get; set; }
    public bool Prerelease { get; set; }
    public List<GitHubAsset>? Assets { get; set; }
}

internal sealed class GitHubAsset
{
    public string? Name { get; set; }
    public string? BrowserDownloadUrl { get; set; }
}
