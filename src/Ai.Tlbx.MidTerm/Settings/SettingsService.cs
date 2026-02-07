using System.Collections.Concurrent;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services;

namespace Ai.Tlbx.MidTerm.Settings;

public sealed class SettingsService
{
    private readonly string _settingsPath;
    private readonly ISecretStorage _secretStorage;
    private MidTermSettings? _cached;
    private readonly object _lock = new();
    private readonly ConcurrentDictionary<string, Action<MidTermSettings>> _settingsListeners = new();

    public SettingsLoadStatus LoadStatus { get; private set; } = SettingsLoadStatus.Default;
    public string? LoadError { get; private set; }
    public string SettingsPath => _settingsPath;
    public string SettingsDirectory => Path.GetDirectoryName(_settingsPath)!;
    public bool IsRunningAsService { get; }
    public ISecretStorage SecretStorage => _secretStorage;

    public SettingsService()
    {
        IsRunningAsService = DetectServiceMode();
        _settingsPath = GetSettingsPath(IsRunningAsService);
        _secretStorage = SecretStorageFactory.Create(SettingsDirectory, IsRunningAsService);
    }

    internal SettingsService(string settingsDirectory)
    {
        IsRunningAsService = false;
        _settingsPath = Path.Combine(settingsDirectory, "settings.json");
        _secretStorage = SecretStorageFactory.Create(settingsDirectory, IsRunningAsService);
    }

    /// <summary>
    /// Returns the settings file path based on service mode.
    /// SYNC: These paths MUST match:
    ///   - install.sh (PATH_CONSTANTS section)
    ///   - install.ps1 (Path Constants section)
    ///   - LogPaths.cs (GetSettingsDirectory method)
    ///   - UpdateScriptGenerator.cs (CONFIG_DIR variable)
    /// </summary>
    private static string GetSettingsPath(bool isService)
    {
        if (isService)
        {
            if (OperatingSystem.IsWindows())
            {
                // Windows service: %ProgramData%\MidTerm (typically C:\ProgramData\MidTerm)
                var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                return Path.Combine(programData, "MidTerm", "settings.json");
            }
            else
            {
                // Unix service: lowercase 'midterm' - MUST match install.sh
                return "/usr/local/etc/midterm/settings.json";
            }
        }

        // User mode: ~/.midterm
        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var configDir = Path.Combine(userDir, ".midterm");
        return Path.Combine(configDir, "settings.json");
    }

    private static bool DetectServiceMode()
    {
        if (OperatingSystem.IsWindows())
        {
            return IsWindowsService();
        }
        else
        {
            // Check if service settings file exists - this is written by the installer
            // We can't rely on getuid() == 0 because macOS launchd services can run as non-root
            return File.Exists("/usr/local/etc/midterm/settings.json");
        }
    }

    private static bool IsWindowsService()
    {
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }

        try
        {
            var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            return identity.IsSystem;
        }
        catch
        {
            return false;
        }
    }


    public MidTermSettings Load()
    {
        lock (_lock)
        {
            if (_cached is not null)
            {
                return _cached;
            }

            if (!File.Exists(_settingsPath))
            {
                _cached = new MidTermSettings();
                LoadSecretsIntoSettings(_cached);
                LoadStatus = SettingsLoadStatus.Default;
                return _cached;
            }

            try
            {
                var json = File.ReadAllText(_settingsPath);
                _cached = JsonSerializer.Deserialize(json, SettingsJsonContext.Default.MidTermSettings)
                    ?? new MidTermSettings();

                // Apply defaults for properties that may be missing from older settings files
                // System.Text.Json leaves missing bool properties as false, not their initializer value
                ApplyMissingDefaults(_cached, json);

                // Migrate service install flag for existing installations
                MigrateServiceInstallFlag(_cached, json);

                // Load secrets from secure storage
                LoadSecretsIntoSettings(_cached);

                LoadStatus = SettingsLoadStatus.LoadedFromFile;

                // Check for .old file and migrate user preferences
                var oldPath = _settingsPath + ".old";
                if (File.Exists(oldPath))
                {
                    try
                    {
                        MigrateFromOldSettings(oldPath, _cached);
                        Save(_cached);
                        File.Delete(oldPath);
                        LoadStatus = SettingsLoadStatus.MigratedFromOld;
                        Log.Info(() => "Successfully migrated settings from .old file");
                    }
                    catch (Exception ex)
                    {
                        Log.Warn(() => $"Failed to migrate settings from .old file: {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                _cached = new MidTermSettings();
                LoadSecretsIntoSettings(_cached);
                LoadStatus = SettingsLoadStatus.ErrorFallbackToDefault;
                LoadError = ex.Message;
            }

            return _cached;
        }
    }

    private void LoadSecretsIntoSettings(MidTermSettings settings)
    {
        settings.SessionSecret = _secretStorage.GetSecret(SecretKeys.SessionSecret);
        settings.PasswordHash = _secretStorage.GetSecret(SecretKeys.PasswordHash);
        settings.CertificatePassword = _secretStorage.GetSecret(SecretKeys.CertificatePassword);
        settings.VoiceServerPassword = _secretStorage.GetSecret(SecretKeys.VoiceServerPassword);
    }

    private static void ApplyMissingDefaults(MidTermSettings settings, string json)
    {
        // For boolean properties with non-false defaults, check if they were present in the JSON
        // If not present, apply the intended default value
        if (!json.Contains("\"useWebGL\"", StringComparison.OrdinalIgnoreCase))
        {
            settings.UseWebGL = true;
        }

        if (!json.Contains("\"cursorBlink\"", StringComparison.OrdinalIgnoreCase))
        {
            settings.CursorBlink = true;
        }

        if (!json.Contains("\"rightClickPaste\"", StringComparison.OrdinalIgnoreCase))
        {
            settings.RightClickPaste = true;
        }

        if (!json.Contains("\"fileRadar\"", StringComparison.OrdinalIgnoreCase))
        {
            settings.FileRadar = true;
        }
    }

    private void MigrateServiceInstallFlag(MidTermSettings settings, string json)
    {
        // If isServiceInstall wasn't in the JSON, infer from directory location
        // This ensures DPAPI scope is consistent for existing installations
        if (!json.Contains("\"isServiceInstall\"", StringComparison.OrdinalIgnoreCase))
        {
            // Service mode settings are in ProgramData (Windows) or /usr/local/etc (Unix)
            // User mode settings are in user profile directory
            if (OperatingSystem.IsWindows())
            {
                var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                settings.IsServiceInstall = _settingsPath.StartsWith(programData, StringComparison.OrdinalIgnoreCase);
            }
            else
            {
                settings.IsServiceInstall = _settingsPath.StartsWith("/usr/local/", StringComparison.Ordinal);
            }

            Log.Info(() => $"Migrated isServiceInstall={settings.IsServiceInstall} based on settings path: {_settingsPath}");
        }
    }

    private static void MigrateFromOldSettings(string oldPath, MidTermSettings current)
    {
        var oldJson = File.ReadAllText(oldPath);
        var old = JsonSerializer.Deserialize(oldJson, SettingsJsonContext.Default.MidTermSettings);
        if (old is null)
        {
            return;
        }

        // Migrate user preferences (keep security settings from current/installer)
        current.DefaultShell = old.DefaultShell;
        current.DefaultCols = old.DefaultCols;
        current.DefaultRows = old.DefaultRows;
        current.DefaultWorkingDirectory = old.DefaultWorkingDirectory;
        current.FontSize = old.FontSize;
        current.CursorStyle = old.CursorStyle;
        current.CursorBlink = old.CursorBlink;
        current.Theme = old.Theme;
        current.ScrollbackLines = old.ScrollbackLines;
        current.BellStyle = old.BellStyle;
        current.CopyOnSelect = old.CopyOnSelect;
        current.RightClickPaste = old.RightClickPaste;

        // Migrate certificate settings if not already set by installer
        // These are critical for preserving trusted certificates across updates
        if (string.IsNullOrEmpty(current.CertificatePath) && !string.IsNullOrEmpty(old.CertificatePath))
        {
            current.CertificatePath = old.CertificatePath;
            current.KeyProtection = old.KeyProtection;
            Log.Info(() => $"Migrated certificate path from old settings: {old.CertificatePath}");
        }

        // Note: RunAsUser/RunAsUserSid/RunAsUid/RunAsGid are NOT migrated
        // They come from the installer which captures the current user
    }

    public void Save(MidTermSettings settings)
    {
        lock (_lock)
        {
            // Save secrets to secure storage
            SaveSecretsFromSettings(settings);

            var dir = Path.GetDirectoryName(_settingsPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            // Secrets have [JsonIgnore] so they won't be written to settings.json
            var json = JsonSerializer.Serialize(settings, SettingsJsonContext.Default.MidTermSettings);
            File.WriteAllText(_settingsPath, json);
            _cached = settings;
        }

        NotifySettingsChange(settings);
    }

    private void SaveSecretsFromSettings(MidTermSettings settings)
    {
        if (!string.IsNullOrEmpty(settings.SessionSecret))
        {
            _secretStorage.SetSecret(SecretKeys.SessionSecret, settings.SessionSecret);
        }

        if (!string.IsNullOrEmpty(settings.PasswordHash))
        {
            _secretStorage.SetSecret(SecretKeys.PasswordHash, settings.PasswordHash);
        }

        if (!string.IsNullOrEmpty(settings.CertificatePassword))
        {
            _secretStorage.SetSecret(SecretKeys.CertificatePassword, settings.CertificatePassword);
        }
        else
        {
            _secretStorage.DeleteSecret(SecretKeys.CertificatePassword);
        }

        if (!string.IsNullOrEmpty(settings.VoiceServerPassword))
        {
            _secretStorage.SetSecret(SecretKeys.VoiceServerPassword, settings.VoiceServerPassword);
        }
    }

    public void InvalidateCache()
    {
        lock (_lock)
        {
            _cached = null;
        }
    }

    public string AddSettingsListener(Action<MidTermSettings> callback)
    {
        var id = Guid.NewGuid().ToString("N");
        _settingsListeners[id] = callback;
        return id;
    }

    public void RemoveSettingsListener(string id)
    {
        _settingsListeners.TryRemove(id, out _);
    }

    private void NotifySettingsChange(MidTermSettings settings)
    {
        foreach (var listener in _settingsListeners.Values)
        {
            try
            {
                listener(settings);
            }
            catch (Exception ex)
            {
                Log.Exception(ex, "SettingsService.NotifySettingsChange");
            }
        }
    }
}
