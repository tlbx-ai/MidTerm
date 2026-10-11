using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>Copies link entries, including Windows junctions, without opening their targets.</summary>
internal static partial class FileEntryLinks
{
    internal static bool Exists(string path)
    {
        try { _ = File.GetAttributes(path); return true; }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return false; }
    }

    internal static bool IsDirectory(string path) => (File.GetAttributes(path) & FileAttributes.Directory) != 0;
    internal static bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;

    internal static byte[] Descriptor(string path)
    {
        if (OperatingSystem.IsWindows()) return ReadWindows(path);
        FileSystemInfo entry = IsDirectory(path) ? new DirectoryInfo(path) : new FileInfo(path);
        return System.Text.Encoding.UTF8.GetBytes(entry.LinkTarget ?? throw new IOException("The link descriptor is unavailable."));
    }

    internal static void Copy(string source, string target)
    {
        var directory = IsDirectory(source);
        if (OperatingSystem.IsWindows()) { CreateWindows(target, directory, ReadWindows(source)); return; }
        var linkTarget = System.Text.Encoding.UTF8.GetString(Descriptor(source));
        if (directory) Directory.CreateSymbolicLink(target, linkTarget);
        else File.CreateSymbolicLink(target, linkTarget);
    }

    [SupportedOSPlatform("windows")]
    private static byte[] ReadWindows(string path)
    {
        using var handle = OpenEntry(path, 0);
        var data = new byte[16 * 1024];
        if (!DeviceIoControl(handle, 0x000900A8, null, 0, data, data.Length, out var count, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastPInvokeError());
        var tag = BitConverter.ToUInt32(data);
        if (tag is not (0xA000000C or 0xA0000003))
            throw new FileDocumentException(422, "unsupported_link", "This reparse point cannot be copied safely.");
        return data[..count];
    }

    [SupportedOSPlatform("windows")]
    private static void CreateWindows(string path, bool directory, byte[] data)
    {
        if (directory) Directory.CreateDirectory(path);
        else using (File.Create(path)) { }
        try
        {
            using var handle = OpenEntry(path, 0x40000000);
            if (!DeviceIoControl(handle, 0x000900A4, data, data.Length, null, 0, out _, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        catch
        {
            // Only this just-created, empty placeholder belongs to this method.
            if (directory) Directory.Delete(path); else File.Delete(path);
            throw;
        }
    }

    [SupportedOSPlatform("windows")]
    private static SafeFileHandle OpenEntry(string path, uint access)
    {
        var handle = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        var error = Marshal.GetLastPInvokeError(); handle.Dispose(); throw new Win32Exception(error);
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial SafeFileHandle CreateFileW(string name, uint access, uint sharing,
        IntPtr security, uint creation, uint flags, IntPtr template);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool DeviceIoControl(SafeFileHandle handle, uint code,
        byte[]? input, int inputSize, byte[]? output, int outputSize, out int returned, IntPtr overlapped);
}
