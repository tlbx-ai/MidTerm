using System.Diagnostics.CodeAnalysis;

namespace Ai.Tlbx.MidTerm.Services;

public static class SecretStorageFactory
{
    [SuppressMessage("Interoperability", "CA1416:Validate platform compatibility",
        Justification = "Platform checks are performed via OperatingSystem.IsX() guards")]
    public static ISecretStorage Create(string settingsDirectory, bool isServiceMode)
    {
#if WINDOWS
        return new WindowsSecretStorage(settingsDirectory, isServiceMode);
#else
        // macOS: Use Keychain for user mode, file-based for service mode
        // Keychain access from launchd services is unreliable due to ACL restrictions
        if (OperatingSystem.IsMacOS() && !isServiceMode)
        {
            return new MacOsSecretStorage();
        }

        // Linux and macOS service mode use file-based storage
        return new UnixFileSecretStorage(settingsDirectory);
#endif
    }
}
