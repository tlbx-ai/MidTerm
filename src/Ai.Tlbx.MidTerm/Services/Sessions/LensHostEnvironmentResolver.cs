using System.Diagnostics;
using Ai.Tlbx.MidTerm.Settings;

#if WINDOWS
using Microsoft.Win32;
#endif

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class LensHostEnvironmentResolver
{
    public static void ApplyUserProfileEnvironment(ProcessStartInfo startInfo, MidTermSettings settings)
    {
        ArgumentNullException.ThrowIfNull(startInfo);
        ArgumentNullException.ThrowIfNull(settings);

        if (!OperatingSystem.IsWindows() || string.IsNullOrWhiteSpace(settings.RunAsUser))
        {
            return;
        }

        var profileDirectory = ResolveWindowsProfileDirectory(settings.RunAsUser, settings.RunAsUserSid);
        if (string.IsNullOrWhiteSpace(profileDirectory) || !Directory.Exists(profileDirectory))
        {
            return;
        }

        startInfo.Environment["USERPROFILE"] = profileDirectory;
        startInfo.Environment["HOME"] = profileDirectory;
        startInfo.Environment["CODEX_HOME"] = Path.Combine(profileDirectory, ".codex");

        var root = Path.GetPathRoot(profileDirectory);
        if (!string.IsNullOrWhiteSpace(root))
        {
            startInfo.Environment["HOMEDRIVE"] = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            startInfo.Environment["HOMEPATH"] = profileDirectory[root.Length..];
        }

        var appDataDirectory = Path.Combine(profileDirectory, "AppData", "Roaming");
        var localAppDataDirectory = Path.Combine(profileDirectory, "AppData", "Local");
        startInfo.Environment["APPDATA"] = appDataDirectory;
        startInfo.Environment["LOCALAPPDATA"] = localAppDataDirectory;

        // Lens runtimes often rely on per-user npm shims like %APPDATA%\npm\codex.cmd.
        // Service environments do not always inherit those PATH entries, so add the
        // common user-local bin locations explicitly for standalone Lens sessions.
        PrependPath(startInfo, Path.Combine(appDataDirectory, "npm"));
        PrependPath(startInfo, Path.Combine(localAppDataDirectory, "Programs", "nodejs"));
    }

    internal static string? ResolveWindowsProfileDirectory(string? userName, string? userSid)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

#if WINDOWS
        if (!string.IsNullOrWhiteSpace(userSid))
        {
            const string profileListRoot = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";
            using var profileKey = Registry.LocalMachine.OpenSubKey(Path.Combine(profileListRoot, userSid));
            var profilePath = profileKey?.GetValue("ProfileImagePath") as string;
            if (!string.IsNullOrWhiteSpace(profilePath))
            {
                return Environment.ExpandEnvironmentVariables(profilePath);
            }
        }
#endif

        if (string.IsNullOrWhiteSpace(userName))
        {
            return null;
        }

        var currentUserProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var usersRoot = Directory.GetParent(currentUserProfile)?.FullName;
        return string.IsNullOrWhiteSpace(usersRoot)
            ? null
            : Path.Combine(usersRoot, userName);
    }

    private static void PrependPath(ProcessStartInfo startInfo, string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            return;
        }

        var existingPath = startInfo.Environment.TryGetValue("PATH", out var currentPath)
            ? currentPath ?? string.Empty
            : Environment.GetEnvironmentVariable("PATH") ?? string.Empty;

        var parts = existingPath
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Contains(directory, StringComparer.OrdinalIgnoreCase))
        {
            return;
        }

        startInfo.Environment["PATH"] = string.IsNullOrWhiteSpace(existingPath)
            ? directory
            : directory + Path.PathSeparator + existingPath;
    }
}
