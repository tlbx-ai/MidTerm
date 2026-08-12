using System.Buffers;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class ForegroundProcessEnvironmentReader
{
    private const int MaxEnvironmentBytes = 1024 * 1024;

    public static string? TryReadVariable(int processId, string variableName)
    {
        if (processId <= 0 || string.IsNullOrWhiteSpace(variableName))
        {
            return null;
        }

        if (OperatingSystem.IsWindows())
        {
            return TryReadWindowsVariable(processId, variableName);
        }

        if (OperatingSystem.IsLinux())
        {
            return TryReadLinuxVariable(processId, variableName);
        }

        return null;
    }

    public static string? TryReadVariableFromProcessTree(int rootProcessId, string variableName)
    {
        var rootValue = TryReadVariable(rootProcessId, variableName);
        if (!string.IsNullOrWhiteSpace(rootValue))
        {
            return rootValue;
        }

        foreach (var processId in EnumerateDescendantProcessIds(rootProcessId))
        {
            var value = TryReadVariable(processId, variableName);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }

    internal static string? FindVariable(string environmentBlock, string variableName)
    {
        foreach (var entry in environmentBlock.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = entry.IndexOf("=", StringComparison.Ordinal);
            if (separator <= 0 || !entry.AsSpan(0, separator).Equals(variableName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return entry[(separator + 1)..];
        }

        return null;
    }

    private static string? TryReadLinuxVariable(int processId, string variableName)
    {
        try
        {
            var path = "/proc/" + processId.ToString(CultureInfo.InvariantCulture) + "/environ";
            var bytes = File.ReadAllBytes(path);
            return FindVariable(Encoding.UTF8.GetString(bytes), variableName);
        }
        catch
        {
            return null;
        }
    }

    private static string? TryReadWindowsVariable(int processId, string variableName)
    {
        var processHandle = OpenProcess(ProcessQueryInformation | ProcessVmRead, false, (uint)processId);
        if (processHandle == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var processInfo = new ProcessBasicInformation();
            if (NtQueryInformationProcess(
                    processHandle,
                    0,
                    ref processInfo,
                    Marshal.SizeOf<ProcessBasicInformation>(),
                    out _) != 0 ||
                processInfo.PebBaseAddress == IntPtr.Zero)
            {
                return null;
            }

            var processParametersOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
            var environmentOffset = IntPtr.Size == 8 ? 0x80 : 0x48;
            var processParameters = ReadRemotePointer(
                processHandle,
                IntPtr.Add(processInfo.PebBaseAddress, processParametersOffset));
            if (processParameters == IntPtr.Zero)
            {
                return null;
            }

            var environment = ReadRemotePointer(processHandle, IntPtr.Add(processParameters, environmentOffset));
            if (environment == IntPtr.Zero)
            {
                return null;
            }

            var buffer = ArrayPool<byte>.Shared.Rent(MaxEnvironmentBytes);
            try
            {
                var length = ReadWindowsEnvironmentBlock(processHandle, environment, buffer);
                if (length <= 0)
                {
                    return null;
                }

                return FindVariable(Encoding.Unicode.GetString(buffer, 0, length), variableName);
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }
        catch
        {
            return null;
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }

    private static int ReadWindowsEnvironmentBlock(IntPtr processHandle, IntPtr environment, byte[] destination)
    {
        const int chunkSize = 4096;
        var totalRead = 0;
        while (totalRead < MaxEnvironmentBytes)
        {
            var requested = Math.Min(chunkSize, MaxEnvironmentBytes - totalRead);
            var chunk = new byte[requested];
            var read = ReadProcessMemory(
                processHandle,
                IntPtr.Add(environment, totalRead),
                chunk,
                requested,
                out var bytesRead);
            if ((!read && bytesRead <= 0) || bytesRead <= 0)
            {
                return -1;
            }

            chunk.AsSpan(0, bytesRead).CopyTo(destination.AsSpan(totalRead));
            totalRead += bytesRead;
            var terminator = FindUnicodeEnvironmentTerminator(destination.AsSpan(0, totalRead));
            if (terminator > 0)
            {
                return terminator;
            }

            if (bytesRead < requested)
            {
                return -1;
            }
        }

        return -1;
    }

    private static IReadOnlyList<int> EnumerateDescendantProcessIds(int rootProcessId)
    {
        if (OperatingSystem.IsWindows())
        {
            return EnumerateWindowsDescendantProcessIds(rootProcessId);
        }

        if (OperatingSystem.IsLinux())
        {
            return EnumerateLinuxDescendantProcessIds(rootProcessId);
        }

        return [];
    }

    private static IReadOnlyList<int> EnumerateWindowsDescendantProcessIds(int rootProcessId)
    {
        var snapshot = CreateToolhelp32Snapshot(Th32csSnapprocess, 0);
        if (snapshot == IntPtr.Zero || snapshot == InvalidHandleValue)
        {
            return [];
        }

        try
        {
            var childrenByParent = new Dictionary<int, List<int>>();
            var entry = new ProcessEntry32 { Size = (uint)Marshal.SizeOf<ProcessEntry32>() };
            if (Process32First(snapshot, ref entry))
            {
                do
                {
                    var parentId = unchecked((int)entry.ParentProcessId);
                    var processId = unchecked((int)entry.ProcessId);
                    if (!childrenByParent.TryGetValue(parentId, out var children))
                    {
                        children = [];
                        childrenByParent[parentId] = children;
                    }

                    children.Add(processId);
                }
                while (Process32Next(snapshot, ref entry));
            }

            return TraverseDescendants(rootProcessId, childrenByParent);
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static IReadOnlyList<int> EnumerateLinuxDescendantProcessIds(int rootProcessId)
    {
        try
        {
            var childrenByParent = new Dictionary<int, List<int>>();
            foreach (var directory in Directory.EnumerateDirectories("/proc"))
            {
                if (!int.TryParse(Path.GetFileName(directory), CultureInfo.InvariantCulture, out var processId))
                {
                    continue;
                }

                var stat = File.ReadAllText(Path.Combine(directory, "stat"));
                var commandEnd = stat.LastIndexOf(')');
                if (commandEnd < 0)
                {
                    continue;
                }

                var fields = stat[(commandEnd + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length < 2 || !int.TryParse(fields[1], CultureInfo.InvariantCulture, out var parentId))
                {
                    continue;
                }

                if (!childrenByParent.TryGetValue(parentId, out var children))
                {
                    children = [];
                    childrenByParent[parentId] = children;
                }

                children.Add(processId);
            }

            return TraverseDescendants(rootProcessId, childrenByParent);
        }
        catch
        {
            return [];
        }
    }

    private static IReadOnlyList<int> TraverseDescendants(
        int rootProcessId,
        IReadOnlyDictionary<int, List<int>> childrenByParent)
    {
        var descendants = new List<int>();
        var pending = new Queue<int>();
        var seen = new HashSet<int> { rootProcessId };
        pending.Enqueue(rootProcessId);

        while (pending.TryDequeue(out var parentId))
        {
            if (!childrenByParent.TryGetValue(parentId, out var children))
            {
                continue;
            }

            foreach (var childId in children)
            {
                if (!seen.Add(childId))
                {
                    continue;
                }

                descendants.Add(childId);
                pending.Enqueue(childId);
            }
        }

        return descendants;
    }

    private static IntPtr ReadRemotePointer(IntPtr processHandle, IntPtr address)
    {
        var buffer = new byte[IntPtr.Size];
        if (!ReadProcessMemory(processHandle, address, buffer, buffer.Length, out var bytesRead) ||
            bytesRead != buffer.Length)
        {
            return IntPtr.Zero;
        }

        return IntPtr.Size == 8
            ? checked((IntPtr)BitConverter.ToInt64(buffer))
            : checked((IntPtr)BitConverter.ToInt32(buffer));
    }

    private static int FindUnicodeEnvironmentTerminator(ReadOnlySpan<byte> bytes)
    {
        for (var i = 0; i + 3 < bytes.Length; i += 2)
        {
            if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 0)
            {
                return i + 2;
            }
        }

        return -1;
    }

    private const uint ProcessQueryInformation = 0x0400;
    private const uint ProcessVmRead = 0x0010;
    private const uint Th32csSnapprocess = 0x00000002;
    private static readonly IntPtr InvalidHandleValue = new(-1);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref ProcessBasicInformation processInformation,
        int processInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        IntPtr processHandle,
        IntPtr baseAddress,
        byte[] buffer,
        int size,
        out int bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableFile;
    }
}
