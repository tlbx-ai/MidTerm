using Ai.Tlbx.MidTerm.Common.Identity;

namespace Ai.Tlbx.MidTerm.Common.Logging;

/// <summary>
/// Centralized path constants for tlbx and compatible legacy MidTerm directories.
/// SYNC: These paths MUST match the following files:
///   - install.sh (PATH_CONSTANTS section)
///   - install.ps1 (Path Constants section)
///   - UpdateScriptGenerator.cs (uses these constants via this class)
///   - SettingsService.cs (GetSettingsPath method)
/// </summary>
public static class LogPaths
{
    // === UNIX SERVICE PATHS ===
    // SYNC: Must match install.sh PATH_CONSTANTS section
    private const string UnixServiceLogDir = "/usr/local/var/log";
    public static string GetLogDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            return Path.Combine(GetSettingsDirectory(true), "Logs");
        }

        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return UnixServiceLogDir;
        }

        return Path.Combine(GetSettingsDirectory(false), "logs");
    }

    public static string GetBackgroundDirectory(string settingsDirectory)
    {
        return Path.Combine(settingsDirectory, "backgrounds");
    }

    public static string GetLegacyBackgroundDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return Path.Combine(UnixServiceLogDir, "midterm-backgrounds");
        }

        return Path.Combine(GetLogDirectory(isWindowsService, isUnixService), "backgrounds");
    }

    public static string GetDataDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            return Path.Combine(GetSettingsDirectory(true), "Data");
        }

        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return Path.Combine(UnixServiceLogDir, "data");
        }

        return Path.Combine(GetSettingsDirectory(false), "data");
    }

    public static string GetSettingsDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            return TlbxProductIdentity.SelectSettingsDirectory(
                TlbxProductIdentity.GetWindowsServiceSettingsDirectory(),
                TlbxProductIdentity.GetLegacyWindowsServiceSettingsDirectory());
        }

        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return TlbxProductIdentity.SelectSettingsDirectory(
                TlbxProductIdentity.UnixServiceSettingsDirectory,
                TlbxProductIdentity.LegacyUnixServiceSettingsDirectory);
        }

        return TlbxProductIdentity.SelectSettingsDirectory(
            TlbxProductIdentity.GetUserSettingsDirectory(),
            TlbxProductIdentity.GetLegacyUserSettingsDirectory());
    }

    public static string GetUpdateLogPath(bool isWindowsService, bool isUnixService, string? settingsDirectory = null)
    {
        if (OperatingSystem.IsWindows())
        {
            var dir = settingsDirectory ?? GetSettingsDirectory(isWindowsService);
            return Path.Combine(dir, "update.log");
        }

        if (isUnixService)
        {
            return Path.Combine(UnixServiceLogDir, "update.log");
        }

        return Path.Combine(GetLogDirectory(isWindowsService, isUnixService), "update.log");
    }

    public static bool DetectWindowsServiceMode()
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
}
