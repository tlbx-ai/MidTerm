using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Settings;

public enum SettingsLoadStatus
{
    Default,
    LoadedFromFile,
    MigratedFromOld,
    ErrorFallbackToDefault
}

public sealed class SettingsService
{
    private readonly string _settingsPath;
    private MidTermSettings? _cached;
    private readonly object _lock = new();
    private readonly ConcurrentDictionary<string, Action<MidTermSettings>> _settingsListeners = new();

    public SettingsLoadStatus LoadStatus { get; private set; } = SettingsLoadStatus.Default;
    public string? LoadError { get; private set; }
    public string SettingsPath => _settingsPath;
    public bool IsRunningAsService { get; }

    public SettingsService()
    {
        IsRunningAsService = DetectServiceMode();
        _settingsPath = GetSettingsPath(IsRunningAsService);
    }

    private static string GetSettingsPath(bool isService)
    {
        if (isService)
        {
            if (OperatingSystem.IsWindows())
            {
                var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                return Path.Combine(programData, "MidTerm", "settings.json");
            }
            else
            {
                return "/usr/local/etc/midterm/settings.json";
            }
        }

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
            return getuid() == 0;
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

    [DllImport("libc", EntryPoint = "getuid")]
    private static extern uint getuid();

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
                    }
                    catch
                    {
                        // Migration is best-effort, continue with loaded settings
                    }
                }
            }
            catch (Exception ex)
            {
                _cached = new MidTermSettings();
                LoadStatus = SettingsLoadStatus.ErrorFallbackToDefault;
                LoadError = ex.Message;
            }

            return _cached;
        }
    }

    private static void ApplyMissingDefaults(MidTermSettings settings, string json)
    {
        // For boolean properties with non-false defaults, check if they were present in the JSON
        // If not present, apply the intended default value
        if (!json.Contains("\"useWebGL\"", StringComparison.OrdinalIgnoreCase))
        {
            settings.UseWebGL = true;
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

        // Note: RunAsUser/RunAsUserSid/RunAsUid/RunAsGid are NOT migrated
        // They come from the installer which captures the current user
    }

    public void Save(MidTermSettings settings)
    {
        lock (_lock)
        {
            var dir = Path.GetDirectoryName(_settingsPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var json = JsonSerializer.Serialize(settings, SettingsJsonContext.Default.MidTermSettings);
            File.WriteAllText(_settingsPath, json);
            _cached = settings;
        }

        NotifySettingsChange(settings);
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
