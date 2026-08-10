namespace Ai.Tlbx.MidTerm.Common.Identity;

/// <summary>
/// Product identity and install-layout compatibility rules.
/// New installations use tlbx names. Existing MidTerm layouts remain readable
/// and updateable in place; they are not silently moved during an update.
/// </summary>
public static class TlbxProductIdentity
{
    public const string ProductName = "tlbx";
    public const string LegacyProductName = "MidTerm";

    public const string UnixServiceSettingsDirectory = "/usr/local/etc/tlbx";
    public const string LegacyUnixServiceSettingsDirectory = "/usr/local/etc/midterm";
    public const string LegacyUnixMultiInstanceSettingsDirectory = "/usr/local/etc/midterm-instances";

    public const string UserSettingsDirectoryName = ".tlbx";
    public const string LegacyUserSettingsDirectoryName = ".midterm";

    public const string CertificateFileName = "tlbx.pem";
    public const string LegacyCertificateFileName = "midterm.pem";
    public const string CertificateKeyId = "tlbx";
    public const string LegacyCertificateKeyId = "midterm";
    public const string CertificateSubject = "CN=tlbx";
    public const string LegacyCertificateSubject = "CN=ai.tlbx.midterm";

    public const string MacOsKeychainPrefix = "ai.tlbx";
    public const string LegacyMacOsKeychainPrefix = "ai.tlbx.midterm";

    public static string GetWindowsServiceSettingsDirectory()
    {
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        return Path.Combine(programData, ProductName);
    }

    public static string GetLegacyWindowsServiceSettingsDirectory()
    {
        var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        return Path.Combine(programData, LegacyProductName);
    }

    public static string GetUserSettingsDirectory()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userProfile, UserSettingsDirectoryName);
    }

    public static string GetLegacyUserSettingsDirectory()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userProfile, LegacyUserSettingsDirectoryName);
    }

    public static string SelectSettingsDirectory(string currentDirectory, string legacyDirectory)
    {
        if (ContainsInstallState(currentDirectory))
        {
            return currentDirectory;
        }

        if (ContainsInstallState(legacyDirectory))
        {
            return legacyDirectory;
        }

        return currentDirectory;
    }

    public static bool ContainsInstallState(string directory)
    {
        try
        {
            if (!Directory.Exists(directory))
            {
                return false;
            }

            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var name = Path.GetFileName(entry);
                if (name.Equals("logs", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("update.log", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("startup-debug.log", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals(".write-check", StringComparison.Ordinal))
                {
                    continue;
                }

                return true;
            }
        }
        catch
        {
            // An unreadable existing layout must not steal a fresh install. The
            // installer passes an explicit directory for service installations.
        }

        return false;
    }

    public static bool IsLegacySettingsDirectory(string settingsDirectory)
    {
        var fullPath = Normalize(settingsDirectory);
        var legacyWindowsService = Normalize(GetLegacyWindowsServiceSettingsDirectory());
        var legacyWindowsMulti = Normalize(Path.Combine(legacyWindowsService, "instances"));
        var legacyUnixService = Normalize(LegacyUnixServiceSettingsDirectory);
        var legacyUnixMulti = Normalize(LegacyUnixMultiInstanceSettingsDirectory);
        var legacyUser = Normalize(GetLegacyUserSettingsDirectory());
        return IsSameOrChild(fullPath, legacyWindowsService) ||
               IsSameOrChild(fullPath, legacyWindowsMulti) ||
               IsSameOrChild(fullPath, legacyUnixService) ||
               IsSameOrChild(fullPath, legacyUnixMulti) ||
               IsSameOrChild(fullPath, legacyUser);
    }

    public static string GetCertificateFileName(string settingsDirectory) =>
        IsLegacySettingsDirectory(settingsDirectory) ? LegacyCertificateFileName : CertificateFileName;

    public static string GetCertificateKeyId(string settingsDirectory) =>
        IsLegacySettingsDirectory(settingsDirectory) ? LegacyCertificateKeyId : CertificateKeyId;

    public static string GetCertificateSubject(string settingsDirectory) =>
        IsLegacySettingsDirectory(settingsDirectory) ? LegacyCertificateSubject : CertificateSubject;

    public static string GetMacOsKeychainPrefix(string settingsDirectory) =>
        IsLegacySettingsDirectory(settingsDirectory) ? LegacyMacOsKeychainPrefix : MacOsKeychainPrefix;

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static string Normalize(string path) =>
        Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static bool IsSameOrChild(string path, string root) =>
        path.Equals(root, PathComparison) ||
        path.StartsWith(root + Path.DirectorySeparatorChar, PathComparison) ||
        path.StartsWith(root + Path.AltDirectorySeparatorChar, PathComparison);
}
