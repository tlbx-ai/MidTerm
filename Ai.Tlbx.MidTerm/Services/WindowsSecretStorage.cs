#if WINDOWS
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

[SupportedOSPlatform("windows")]
public sealed class WindowsSecretStorage : ISecretStorage
{
    private readonly string _secretsPath;
    private readonly DataProtectionScope _scope;
    private readonly object _lock = new();
    private Dictionary<string, string>? _cache;

    public WindowsSecretStorage(string settingsDirectory, bool isServiceMode)
    {
        _secretsPath = Path.Combine(settingsDirectory, "secrets.bin");
        _scope = isServiceMode ? DataProtectionScope.LocalMachine : DataProtectionScope.CurrentUser;
    }

    public string? GetSecret(string key)
    {
        lock (_lock)
        {
            EnsureLoaded();
            if (_cache!.TryGetValue(key, out var encryptedBase64))
            {
                try
                {
                    var encrypted = Convert.FromBase64String(encryptedBase64);
                    var decrypted = ProtectedData.Unprotect(encrypted, null, _scope);
                    return Encoding.UTF8.GetString(decrypted);
                }
                catch (CryptographicException ex)
                {
                    Log.Error(() => $"Failed to decrypt secret '{key}': {ex.Message}");
                    return null;
                }
            }
            return null;
        }
    }

    public void SetSecret(string key, string value)
    {
        lock (_lock)
        {
            EnsureLoaded();
            var plainBytes = Encoding.UTF8.GetBytes(value);
            var encrypted = ProtectedData.Protect(plainBytes, null, _scope);
            _cache![key] = Convert.ToBase64String(encrypted);
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
            Log.Error(() => $"Failed to load secrets file: {ex.Message}");
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
            }

            var json = JsonSerializer.Serialize(_cache, SecretsJsonContext.Default.DictionaryStringString);

            // Use FileStream with sharing to allow concurrent access
            using var stream = new FileStream(_secretsPath, FileMode.Create, FileAccess.Write, FileShare.Read);
            using var writer = new StreamWriter(stream);
            writer.Write(json);
        }
        catch (Exception ex)
        {
            Log.Error(() => $"Failed to save secrets file: {ex.Message}");
            throw;
        }
    }
}
#endif
