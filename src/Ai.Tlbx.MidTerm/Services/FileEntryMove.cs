using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>Native no-replace renames; cross-device copies belong to the operation service.</summary>
internal static partial class FileEntryMove
{
    internal static void MoveUnix(string source, string target)
    {
        int result;
        try
        {
            result = OperatingSystem.IsLinux() ? RenameAt2(-100, source, -100, target, 1) :
                OperatingSystem.IsMacOS() ? RenameExclusive(source, target, 4) :
                throw new PlatformNotSupportedException("Native safe rename is unavailable on this platform.");
        }
        catch (EntryPointNotFoundException)
        {
            throw new FileDocumentException(422, "safe_rename_unavailable", "This filesystem cannot safely move entries without overwriting another entry.");
        }
        if (result == 0) return;
        var error = Marshal.GetLastPInvokeError();
        if (error == 17) throw new FileDocumentException(409, "name_conflict", "A file or folder with that name already exists.");
        if (error is 1 or 13 or 30) throw new UnauthorizedAccessException(new Win32Exception(error).Message);
        if (error == 2) throw new FileNotFoundException("The source or destination directory no longer exists.");
        // Preserve EXDEV (18) for the explicit, recoverable cross-volume path.
        throw new IOException(new Win32Exception(error).Message, unchecked((int)(0x80070000u | (uint)(error == 28 ? 112 : error))));
    }

    [LibraryImport("libc", EntryPoint = "renameat2", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    private static partial int RenameAt2(int sourceDirectory, string source, int targetDirectory, string target, uint flags);

    [LibraryImport("libc", EntryPoint = "renamex_np", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
    private static partial int RenameExclusive(string source, string target, uint flags);
}
