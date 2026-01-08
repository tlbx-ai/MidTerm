using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.Common.Logging;

public static class LogPaths
{
    public static string GetLogDirectory(bool isWindowsService)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "MidTerm", "Logs");
        }

        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userDir, ".midterm", "logs");
    }

    public static string GetDataDirectory(bool isWindowsService)
    {
        if (OperatingSystem.IsWindows() && isWindowsService)
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "MidTerm", "Data");
        }

        var userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userDir, ".midterm", "data");
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
