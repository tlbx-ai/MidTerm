#if WINDOWS
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.TtyHost.Process;

/// <summary>
/// Windows implementation of process monitoring using Toolhelp32 for enumeration
/// and NtQueryInformationProcess for CWD retrieval.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsProcessMonitor : IProcessMonitor
{
    private readonly object _lock = new();
    private readonly ConcurrentDictionary<int, ProcessInfo> _processTree = new();
    private int _rootPid;
    private bool _monitoring;
    private bool _disposed;
    private CancellationTokenSource? _pollCts;
    private Task? _pollTask;

    public event Action<ProcessEvent>? OnProcessEvent;
    public event Action<ForegroundProcessInfo>? OnForegroundChanged;

    public bool SupportsRealTimeEvents => false;

    public void StartMonitoring(int rootPid)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(WindowsProcessMonitor));

        lock (_lock)
        {
            _rootPid = rootPid;
            _monitoring = true;

            _pollCts = new CancellationTokenSource();
            _pollTask = Task.Run(() => PollProcessTreeAsync(_pollCts.Token));
        }
    }

    public void StopMonitoring()
    {
        lock (_lock)
        {
            _monitoring = false;
            _pollCts?.Cancel();
            try
            {
                _pollTask?.Wait(1000);
            }
            catch { }
            _pollCts?.Dispose();
            _pollCts = null;
            _pollTask = null;
        }
    }

    private async Task PollProcessTreeAsync(CancellationToken ct)
    {
        var previousPids = new HashSet<int>();
        int? previousForeground = null;

        while (!ct.IsCancellationRequested && _monitoring)
        {
            try
            {
                await Task.Delay(500, ct);

                var currentPids = new HashSet<int>();
                var descendants = GetDescendantProcesses(_rootPid);

                foreach (var pid in descendants)
                {
                    currentPids.Add(pid);

                    if (!previousPids.Contains(pid))
                    {
                        var name = GetProcessName(pid);
                        var cmdLine = GetProcessCommandLine(pid);
                        var parentPid = GetParentPid(pid);

                        var info = new ProcessInfo
                        {
                            Pid = pid,
                            ParentPid = parentPid,
                            Name = name ?? "unknown",
                            CommandLine = cmdLine,
                            Cwd = GetProcessCwd(pid)
                        };
                        _processTree[pid] = info;

                        OnProcessEvent?.Invoke(new ProcessEvent
                        {
                            Type = ProcessEventType.Exec,
                            Pid = pid,
                            ParentPid = parentPid,
                            Name = name,
                            CommandLine = cmdLine,
                            Timestamp = DateTime.UtcNow
                        });
                    }
                }

                foreach (var pid in previousPids)
                {
                    if (!currentPids.Contains(pid))
                    {
                        _processTree.TryRemove(pid, out _);
                        OnProcessEvent?.Invoke(new ProcessEvent
                        {
                            Type = ProcessEventType.Exit,
                            Pid = pid,
                            Timestamp = DateTime.UtcNow
                        });
                    }
                }

                previousPids = currentPids;

                var foreground = GetForegroundProcess(_rootPid);
                if (foreground != previousForeground)
                {
                    previousForeground = foreground;
                    var fgName = GetProcessName(foreground);
                    // Fall back to shell's CWD if foreground process CWD is unavailable
                    var fgCwd = GetProcessCwd(foreground) ?? GetProcessCwd(_rootPid);
                    var fgCmd = StripExecutablePath(GetProcessCommandLine(foreground));

                    OnForegroundChanged?.Invoke(new ForegroundProcessInfo
                    {
                        Pid = foreground,
                        Name = fgName ?? "shell",
                        CommandLine = fgCmd,
                        Cwd = fgCwd
                    });
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Process polling error: {ex.Message}");
            }
        }
    }

    public string? GetProcessCwd(int pid)
    {
        if (_disposed) return null;

        try
        {
            var hProcess = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                false,
                (uint)pid);

            if (hProcess == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                var pbi = new PROCESS_BASIC_INFORMATION();
                int returnLength;
                var status = NtQueryInformationProcess(
                    hProcess,
                    0,
                    ref pbi,
                    Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(),
                    out returnLength);

                if (status != 0 || pbi.PebBaseAddress == IntPtr.Zero)
                {
                    return null;
                }

                // Read PEB to get ProcessParameters pointer (offset 0x20 on x64)
                var pebData = new byte[0x30];
                if (!ReadProcessMemory(hProcess, pbi.PebBaseAddress, pebData, pebData.Length, out _))
                {
                    return null;
                }
                var procParamsPtr = (IntPtr)BitConverter.ToInt64(pebData, 0x20);
                if (procParamsPtr == IntPtr.Zero)
                {
                    return null;
                }

                // Read RTL_USER_PROCESS_PARAMETERS - CurrentDirectory (CURDIR) is at offset 0x38 on x64
                // CURDIR structure: UNICODE_STRING DosPath (16 bytes) + HANDLE Handle (8 bytes)
                // UNICODE_STRING: Length (2) + MaxLength (2) + padding (4) + Buffer ptr (8)
                var paramsData = new byte[0x50];
                if (!ReadProcessMemory(hProcess, procParamsPtr, paramsData, paramsData.Length, out _))
                {
                    return null;
                }

                // CurrentDirectory.DosPath at offset 0x38
                var cwdLength = BitConverter.ToUInt16(paramsData, 0x38);
                var cwdBufferPtr = (IntPtr)BitConverter.ToInt64(paramsData, 0x38 + 8);

                if (cwdLength == 0 || cwdBufferPtr == IntPtr.Zero)
                {
                    return null;
                }

                var buffer = new byte[cwdLength];
                if (!ReadProcessMemory(hProcess, cwdBufferPtr, buffer, buffer.Length, out _))
                {
                    return null;
                }

                var cwd = Encoding.Unicode.GetString(buffer).TrimEnd('\0');
                if (cwd.EndsWith('\\') && cwd.Length > 3)
                {
                    cwd = cwd.TrimEnd('\\');
                }
                return cwd;
            }
            finally
            {
                CloseHandle(hProcess);
            }
        }
        catch (Exception ex)
        {
            Log.Verbose(() => $"GetProcessCwd({pid}) failed: {ex.Message}");
            return null;
        }
    }

    public string? GetProcessName(int pid)
    {
        if (_disposed) return null;

        try
        {
            var hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (hSnapshot == IntPtr.Zero || hSnapshot == INVALID_HANDLE_VALUE)
            {
                return null;
            }

            try
            {
                var pe = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
                if (Process32FirstW(hSnapshot, ref pe))
                {
                    do
                    {
                        if (pe.th32ProcessID == pid)
                        {
                            return pe.szExeFile;
                        }
                    } while (Process32NextW(hSnapshot, ref pe));
                }
            }
            finally
            {
                CloseHandle(hSnapshot);
            }
        }
        catch { }

        return null;
    }

    public string? GetProcessCommandLine(int pid)
    {
        if (_disposed) return null;

        try
        {
            var hProcess = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                false,
                (uint)pid);

            if (hProcess == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                var pbi = new PROCESS_BASIC_INFORMATION();
                var status = NtQueryInformationProcess(
                    hProcess,
                    0,
                    ref pbi,
                    Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(),
                    out _);

                if (status != 0 || pbi.PebBaseAddress == IntPtr.Zero)
                {
                    return null;
                }

                // Read PEB to get ProcessParameters pointer (offset 0x20 on x64)
                var pebData = new byte[0x30];
                if (!ReadProcessMemory(hProcess, pbi.PebBaseAddress, pebData, pebData.Length, out _))
                {
                    return null;
                }
                var procParamsPtr = (IntPtr)BitConverter.ToInt64(pebData, 0x20);
                if (procParamsPtr == IntPtr.Zero)
                {
                    return null;
                }

                // Read RTL_USER_PROCESS_PARAMETERS - CommandLine (UNICODE_STRING) is at offset 0x70 on x64
                var paramsData = new byte[0x80];
                if (!ReadProcessMemory(hProcess, procParamsPtr, paramsData, paramsData.Length, out _))
                {
                    return null;
                }

                // CommandLine at offset 0x70: UNICODE_STRING (Length ushort, MaxLength ushort, padding, Buffer IntPtr)
                var cmdLength = BitConverter.ToUInt16(paramsData, 0x70);
                var cmdBufferPtr = (IntPtr)BitConverter.ToInt64(paramsData, 0x70 + 8);

                if (cmdLength == 0 || cmdBufferPtr == IntPtr.Zero)
                {
                    return null;
                }

                var buffer = new byte[cmdLength];
                if (!ReadProcessMemory(hProcess, cmdBufferPtr, buffer, buffer.Length, out _))
                {
                    return null;
                }

                return Encoding.Unicode.GetString(buffer).TrimEnd('\0');
            }
            finally
            {
                CloseHandle(hProcess);
            }
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Strips the path and .exe extension from a command line, keeping just the command name and arguments.
    /// Also removes unnecessary quotes from arguments for cleaner "as-typed" output.
    /// Example: "C:\Windows\system32\edit.exe" "file.txt" → edit file.txt
    /// </summary>
    private static string? StripExecutablePath(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            return commandLine;
        }

        var cmd = commandLine.AsSpan().Trim();
        if (cmd.IsEmpty)
        {
            return commandLine;
        }

        int exeEnd;
        ReadOnlySpan<char> exeName;
        if (cmd[0] == '"')
        {
            // Quoted executable: find closing quote
            var closeQuote = cmd.Slice(1).IndexOf('"');
            if (closeQuote < 0)
            {
                return commandLine; // Malformed, return as-is
            }
            var exePath = cmd.Slice(1, closeQuote);
            var lastSlash = exePath.LastIndexOfAny(['\\', '/']);
            exeName = lastSlash >= 0 ? exePath.Slice(lastSlash + 1) : exePath;
            exeEnd = closeQuote + 2; // Skip past closing quote
        }
        else
        {
            // Unquoted executable: find first space
            exeEnd = cmd.IndexOf(' ');
            var exePath = exeEnd >= 0 ? cmd.Slice(0, exeEnd) : cmd;
            var lastSlash = exePath.LastIndexOfAny(['\\', '/']);
            exeName = lastSlash >= 0 ? exePath.Slice(lastSlash + 1) : exePath;
        }

        // Strip .exe extension
        if (exeName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            exeName = exeName.Slice(0, exeName.Length - 4);
        }

        var args = exeEnd >= 0 && cmd.Length > exeEnd ? cmd.Slice(exeEnd).TrimStart() : ReadOnlySpan<char>.Empty;
        if (args.IsEmpty)
        {
            return exeName.ToString();
        }

        // Clean up unnecessary quotes from arguments
        var cleanedArgs = CleanArgumentQuotes(args);
        return $"{exeName} {cleanedArgs}";
    }

    /// <summary>
    /// Removes unnecessary quotes from arguments. Quotes are kept only when they contain spaces.
    /// Example: "file.txt" → file.txt, but "file name.txt" stays quoted.
    /// </summary>
    private static string CleanArgumentQuotes(ReadOnlySpan<char> args)
    {
        var result = new StringBuilder();
        var i = 0;

        while (i < args.Length)
        {
            // Skip whitespace
            while (i < args.Length && char.IsWhiteSpace(args[i]))
            {
                result.Append(args[i]);
                i++;
            }

            if (i >= args.Length) break;

            if (args[i] == '"')
            {
                // Find closing quote
                var start = i + 1;
                var end = start;
                while (end < args.Length && args[end] != '"')
                {
                    end++;
                }

                if (end < args.Length)
                {
                    var content = args.Slice(start, end - start);
                    // Keep quotes only if content has spaces or special chars
                    if (content.IndexOf(' ') >= 0 || content.IndexOf('\t') >= 0)
                    {
                        result.Append('"');
                        result.Append(content);
                        result.Append('"');
                    }
                    else
                    {
                        result.Append(content);
                    }
                    i = end + 1;
                }
                else
                {
                    // Unclosed quote, copy as-is
                    result.Append(args.Slice(i));
                    break;
                }
            }
            else
            {
                // Unquoted token - copy until whitespace or end
                while (i < args.Length && !char.IsWhiteSpace(args[i]))
                {
                    result.Append(args[i]);
                    i++;
                }
            }
        }

        return result.ToString();
    }

    public IReadOnlyList<int> GetChildProcesses(int pid)
    {
        if (_disposed) return [];

        var children = new List<int>();
        try
        {
            var hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (hSnapshot == IntPtr.Zero || hSnapshot == INVALID_HANDLE_VALUE)
            {
                return [];
            }

            try
            {
                var pe = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
                if (Process32FirstW(hSnapshot, ref pe))
                {
                    do
                    {
                        if (pe.th32ParentProcessID == pid)
                        {
                            children.Add((int)pe.th32ProcessID);
                        }
                    } while (Process32NextW(hSnapshot, ref pe));
                }
            }
            finally
            {
                CloseHandle(hSnapshot);
            }
        }
        catch { }

        return children;
    }

    private IReadOnlyList<int> GetDescendantProcesses(int rootPid)
    {
        var descendants = new List<int>();
        var toVisit = new Queue<int>();
        toVisit.Enqueue(rootPid);

        while (toVisit.Count > 0)
        {
            var pid = toVisit.Dequeue();
            var children = GetChildProcesses(pid);
            foreach (var child in children)
            {
                if (!descendants.Contains(child))
                {
                    descendants.Add(child);
                    toVisit.Enqueue(child);
                }
            }
        }

        return descendants;
    }

    private int GetParentPid(int pid)
    {
        try
        {
            var hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (hSnapshot == IntPtr.Zero || hSnapshot == INVALID_HANDLE_VALUE)
            {
                return 0;
            }

            try
            {
                var pe = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
                if (Process32FirstW(hSnapshot, ref pe))
                {
                    do
                    {
                        if (pe.th32ProcessID == pid)
                        {
                            return (int)pe.th32ParentProcessID;
                        }
                    } while (Process32NextW(hSnapshot, ref pe));
                }
            }
            finally
            {
                CloseHandle(hSnapshot);
            }
        }
        catch { }

        return 0;
    }

    public int GetForegroundProcess(int shellPid)
    {
        if (_disposed) return shellPid;

        var descendants = GetDescendantProcesses(shellPid);
        if (descendants.Count == 0)
        {
            return shellPid;
        }

        var childrenMap = new Dictionary<int, List<int>>();
        childrenMap[shellPid] = [];

        foreach (var pid in descendants)
        {
            var parent = GetParentPid(pid);
            if (!childrenMap.ContainsKey(parent))
            {
                childrenMap[parent] = [];
            }
            childrenMap[parent].Add(pid);
            if (!childrenMap.ContainsKey(pid))
            {
                childrenMap[pid] = [];
            }
        }

        int FindLeaf(int current)
        {
            if (!childrenMap.TryGetValue(current, out var children) || children.Count == 0)
            {
                return current;
            }
            return FindLeaf(children[0]);
        }

        return FindLeaf(shellPid);
    }

    public ProcessTreeSnapshot GetProcessTreeSnapshot(int shellPid)
    {
        var processes = new List<ProcessInfo>();
        var descendants = GetDescendantProcesses(shellPid);

        foreach (var pid in descendants)
        {
            processes.Add(new ProcessInfo
            {
                Pid = pid,
                ParentPid = GetParentPid(pid),
                Name = GetProcessName(pid) ?? "unknown",
                CommandLine = GetProcessCommandLine(pid),
                Cwd = GetProcessCwd(pid)
            });
        }

        var foregroundPid = GetForegroundProcess(shellPid);
        ForegroundProcessInfo? foreground = null;
        if (foregroundPid != shellPid)
        {
            foreground = new ForegroundProcessInfo
            {
                Pid = foregroundPid,
                Name = GetProcessName(foregroundPid) ?? "unknown",
                CommandLine = GetProcessCommandLine(foregroundPid),
                Cwd = GetProcessCwd(foregroundPid)
            };
        }

        return new ProcessTreeSnapshot
        {
            ShellPid = shellPid,
            ShellCwd = GetProcessCwd(shellPid),
            Foreground = foreground,
            Processes = processes
        };
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopMonitoring();
    }

    #region Native Interop

    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadProcessMemory(
        IntPtr hProcess,
        IntPtr lpBaseAddress,
        byte[] lpBuffer,
        int dwSize,
        out int lpNumberOfBytesRead);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    #endregion
}
#endif
