using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

[SupportedOSPlatform("linux")]
[SupportedOSPlatform("freebsd")]
[SupportedOSPlatform("macos")]
public sealed class UnixFileSecretStorage : ISecretStorage
{
    private const int OwnerReadWrite = 0b110_000_000; // 0600 octal

    private readonly string _secretsPath;
    private readonly object _lock = new();
    private Dictionary<string, string>? _cache;

    public bool LoadFailed { get; private set; }
    public string? LoadError { get; private set; }

    public UnixFileSecretStorage(string settingsDirectory)
    {
        _secretsPath = Path.Combine(settingsDirectory, "secrets.json");
    }

    public string? GetSecret(string key)
    {
        lock (_lock)
        {
            EnsureLoaded();
            return _cache!.TryGetValue(key, out var value) ? value : null;
        }
    }

    public void SetSecret(string key, string value)
    {
        lock (_lock)
        {
            EnsureLoaded();
            _cache![key] = value;
            SaveToFile();
        }
    }

    public void DeleteSecret(string key)
    {
        lock (_lock)
        {
            EnsureLoaded();
            if (_cache!.Remove(key))
            {
                SaveToFile();
            }
        }
    }

    private void EnsureLoaded()
    {
        if (_cache is not null)
        {
            return;
        }

        _cache = new Dictionary<string, string>();

        if (!File.Exists(_secretsPath))
        {
            return;
        }

        try
        {
            // Use FileStream with sharing to allow concurrent access
            using var stream = new FileStream(_secretsPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            var json = reader.ReadToEnd();
            var data = JsonSerializer.Deserialize(json, SecretsJsonContext.Default.DictionaryStringString);
            if (data is not null)
            {
                _cache = data;
            }
        }
        catch (Exception ex)
        {
            LoadFailed = true;
            LoadError = $"Failed to load secrets file '{_secretsPath}': {ex.Message}";
            Log.Error(() => LoadError);
        }
    }

    private void SaveToFile()
    {
        try
        {
            var dir = Path.GetDirectoryName(_secretsPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
                chmod(dir, 0b111_000_000); // 0700 for directory
            }

            var json = JsonSerializer.Serialize(_cache, SecretsJsonContext.Default.DictionaryStringString);

            // Use FileStream with sharing to allow concurrent access
            using var stream = new FileStream(_secretsPath, FileMode.Create, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream);
            writer.Write(json);

            // Set file permissions to owner read/write only (0600)
            var result = chmod(_secretsPath, OwnerReadWrite);
            if (result != 0)
            {
                var errno = Marshal.GetLastWin32Error();
                throw new InvalidOperationException($"Failed to set permissions on secrets file '{_secretsPath}': errno {errno}");
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"Failed to save secrets file: {ex.Message}");
            throw;
        }
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int chmod(string path, int mode);
}
