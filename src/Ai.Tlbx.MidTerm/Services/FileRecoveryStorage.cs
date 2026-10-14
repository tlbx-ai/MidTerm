using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Ai.Tlbx.MidTerm.Services;

internal static class FileRecoveryStorage
{
    internal static void EnsurePrivate(string directory, string? ownerSid = null)
    {
        if (OperatingSystem.IsWindows()) EnsureWindows(directory, ownerSid);
        else
        {
            var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
            Directory.CreateDirectory(directory, mode);
            if (new DirectoryInfo(directory).LinkTarget is not null) throw new UnauthorizedAccessException("Recovery storage cannot be a link.");
            File.SetUnixFileMode(directory, mode);
        }
    }

    [SupportedOSPlatform("windows")]
    private static void EnsureWindows(string directory, string? ownerSid)
    {
        var created = !Directory.Exists(directory);
        Directory.CreateDirectory(directory);
        var info = new DirectoryInfo(directory);
        if (info.LinkTarget is not null) throw new UnauthorizedAccessException("Recovery storage cannot be a reparse point.");
        var acl = created ? new DirectorySecurity() : info.GetAccessControl();
        acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        using var identity = WindowsIdentity.GetCurrent();
        var owners = new[] { identity.User ?? throw new UnauthorizedAccessException(),
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null) }.ToList();
        if (ownerSid is not null) owners.Add(new SecurityIdentifier(ownerSid));
        foreach (var owner in owners)
            acl.SetAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(acl);
    }
}
