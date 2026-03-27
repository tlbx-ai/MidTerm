using System.Diagnostics;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Services.Security;

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

        // Lens runtimes often rely on per-user command shims and local bins.
        // Service environments do not always inherit those PATH entries, so add the
        // common user-local locations explicitly for standalone Lens sessions.
        foreach (var directory in AiCliCommandLocator.GetUserCommandDirectories(profileDirectory).Reverse())
        {
            PrependPath(startInfo, directory);
        }
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
        if (string.IsNullOrWhiteSpace(usersRoot))
        {
            return null;
        }

        var candidates = new List<string>();
        var trimmedUserName = userName.Trim();
        if (!string.IsNullOrWhiteSpace(trimmedUserName))
        {
            candidates.Add(trimmedUserName);
        }

        var normalizedUserName = SystemUserProvider.NormalizeWindowsUsername(userName);
        if (!string.IsNullOrWhiteSpace(normalizedUserName) &&
            !candidates.Contains(normalizedUserName, StringComparer.OrdinalIgnoreCase))
        {
            candidates.Add(normalizedUserName);
        }

        foreach (var candidate in candidates)
        {
            var candidatePath = Path.Combine(usersRoot, candidate);
            if (Directory.Exists(candidatePath))
            {
                return candidatePath;
            }
        }

        var fallbackLeaf = candidates.LastOrDefault();
        return string.IsNullOrWhiteSpace(fallbackLeaf)
            ? null
            : Path.Combine(usersRoot, fallbackLeaf);
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
