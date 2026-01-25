namespace Ai.Tlbx.MidTerm.Common.Logging;

public static class LogPaths
{
    private const string UnixServiceLogDir = "/usr/local/var/log";
    private const string UnixServiceSettingsDir = "/usr/local/etc/midterm";

    public static string GetLogDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "MidTerm", "Logs");
        }

        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return UnixServiceLogDir;
        }

        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userDir, ".midterm", "logs");
    }

    public static string GetDataDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "MidTerm", "Data");
        }

        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return Path.Combine(UnixServiceLogDir, "data");
        }

        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userDir, ".midterm", "data");
    }

    public static string GetSettingsDirectory(bool isWindowsService, bool isUnixService = false)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "MidTerm");
        }

        if (!OperatingSystem.IsWindows() && isUnixService)
        {
            return UnixServiceSettingsDir;
        }

        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userDir, ".midterm");
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

        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userDir, ".midterm", "update.log");
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
