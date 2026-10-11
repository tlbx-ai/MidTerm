using System.Security.AccessControl;

namespace Ai.Tlbx.MidTerm.Services;

internal sealed class FileDirectoryMetadata
{
    public string Path { get; set; } = string.Empty;
    public string? SecurityDescriptor { get; set; }
    public UnixFileMode? UnixMode { get; set; }
    public FileAttributes Attributes { get; set; }

    internal static FileDirectoryMetadata[] CaptureParents(string entry, Func<string, bool> accessible)
    {
        var result = new List<FileDirectoryMetadata>();
        for (var parent = System.IO.Path.GetDirectoryName(entry); parent is not null && accessible(parent); parent = System.IO.Path.GetDirectoryName(parent))
        {
            var metadata = new FileDirectoryMetadata { Path = parent, Attributes = File.GetAttributes(parent) };
            if (OperatingSystem.IsWindows()) metadata.SecurityDescriptor = new DirectoryInfo(parent).GetAccessControl(
                AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group)
                .GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group);
            else metadata.UnixMode = File.GetUnixFileMode(parent);
            result.Add(metadata);
        }
        return result.ToArray();
    }

    internal void Apply(string target)
    {
        if (OperatingSystem.IsWindows() && SecurityDescriptor is not null)
        {
            var security = new DirectorySecurity(); security.SetSecurityDescriptorSddlForm(SecurityDescriptor,
                AccessControlSections.Access | AccessControlSections.Owner | AccessControlSections.Group);
            new DirectoryInfo(target).SetAccessControl(security);
        }
        else if (!OperatingSystem.IsWindows() && UnixMode is { } mode) File.SetUnixFileMode(target, mode);
        File.SetAttributes(target, Attributes);
    }
}
