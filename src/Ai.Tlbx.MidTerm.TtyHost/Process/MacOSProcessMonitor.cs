#if MACOS
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.TtyHost.Process;

/// <summary>
/// macOS implementation of process monitoring using libproc.
/// Uses proc_pidinfo with PROC_PIDVNODEPATHINFO for CWD retrieval.
/// </summary>
public sealed class MacOSProcessMonitor : IProcessMonitor
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
        if (_disposed) throw new ObjectDisposedException(nameof(MacOSProcessMonitor));

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
                            Name = info.Name,
                            CommandLine = cmdLine,
                            Timestamp = DateTime.UtcNow
                        });
                    }
                }

                foreach (var pid in previousPids)
                {
                    if (!currentPids.Contains(pid))
                    {
                        _processTree.TryRemove(pid, out var exitedInfo);
                        OnProcessEvent?.Invoke(new ProcessEvent
                        {
                            Type = ProcessEventType.Exit,
                            Pid = pid,
                            ParentPid = exitedInfo?.ParentPid ?? 0,
                            Name = exitedInfo?.Name,
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
                    var fgCwd = GetProcessCwd(foreground);
                    var fgCmd = GetProcessCommandLine(foreground);

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
            var vnodeInfo = new proc_vnodepathinfo();
            var size = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, ref vnodeInfo, Marshal.SizeOf<proc_vnodepathinfo>());

            if (size <= 0)
            {
                return null;
            }

            return vnodeInfo.pvi_cdir.vip_path?.TrimEnd('\0');
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
            var buffer = new byte[PROC_PIDPATHINFO_MAXSIZE];
            var len = proc_pidpath(pid, buffer, buffer.Length);

            if (len <= 0)
            {
                return null;
            }

            var fullPath = Encoding.UTF8.GetString(buffer, 0, len);
            return Path.GetFileName(fullPath);
        }
        catch
        {
            return null;
        }
    }

    public string? GetProcessCommandLine(int pid)
    {
        if (_disposed) return null;

        try
        {
            var argmax = new int[1];
            var size = (IntPtr)sizeof(int);
            var mib = new int[] { CTL_KERN, KERN_ARGMAX };

            if (sysctl(mib, 2, argmax, ref size, IntPtr.Zero, IntPtr.Zero) != 0)
            {
                return null;
            }

            var buffer = new byte[argmax[0]];
            size = (IntPtr)buffer.Length;
            mib = new int[] { CTL_KERN, KERN_PROCARGS2, pid };

            if (sysctl(mib, 3, buffer, ref size, IntPtr.Zero, IntPtr.Zero) != 0)
            {
                return null;
            }

            if ((int)size < 4)
            {
                return null;
            }

            var argc = BitConverter.ToInt32(buffer, 0);
            var pos = 4;

            while (pos < (int)size && buffer[pos] != 0)
            {
                pos++;
            }
            while (pos < (int)size && buffer[pos] == 0)
            {
                pos++;
            }

            var args = new List<string>();
            for (int i = 0; i < argc && pos < (int)size; i++)
            {
                var start = pos;
                while (pos < (int)size && buffer[pos] != 0)
                {
                    pos++;
                }

                if (pos > start)
                {
                    args.Add(Encoding.UTF8.GetString(buffer, start, pos - start));
                }
                pos++;
            }

            return string.Join(" ", args);
        }
        catch
        {
            return null;
        }
    }

    public IReadOnlyList<int> GetChildProcesses(int pid)
    {
        if (_disposed) return [];

        var children = new List<int>();
        try
        {
            var count = proc_listchildpids(pid, null, 0);
            if (count <= 0)
            {
                return [];
            }

            var pids = new int[count];
            var actualCount = proc_listchildpids(pid, pids, count * sizeof(int));

            if (actualCount > 0)
            {
                var numPids = actualCount / sizeof(int);
                for (int i = 0; i < numPids; i++)
                {
                    if (pids[i] > 0)
                    {
                        children.Add(pids[i]);
                    }
                }
            }
        }
        catch { }

        return children;
    }

    private int GetParentPid(int pid)
    {
        try
        {
            var info = new proc_bsdinfo();
            var size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ref info, Marshal.SizeOf<proc_bsdinfo>());

            if (size > 0)
            {
                return (int)info.pbi_ppid;
            }
        }
        catch { }

        return 0;
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

    private const int PROC_PIDVNODEPATHINFO = 9;
    private const int PROC_PIDTBSDINFO = 3;
    private const int PROC_PIDPATHINFO_MAXSIZE = 4096;

    private const int CTL_KERN = 1;
    private const int KERN_ARGMAX = 8;
    private const int KERN_PROCARGS2 = 49;

    [DllImport("libproc.dylib")]
    private static extern int proc_pidinfo(
        int pid,
        int flavor,
        ulong arg,
        ref proc_vnodepathinfo buffer,
        int bufferSize);

    [DllImport("libproc.dylib")]
    private static extern int proc_pidinfo(
        int pid,
        int flavor,
        ulong arg,
        ref proc_bsdinfo buffer,
        int bufferSize);

    [DllImport("libproc.dylib")]
    private static extern int proc_pidpath(
        int pid,
        byte[] buffer,
        int bufferSize);

    [DllImport("libproc.dylib")]
    private static extern int proc_listchildpids(
        int ppid,
        int[]? buffer,
        int bufferSize);

    [DllImport("libc")]
    private static extern int sysctl(
        int[] name,
        int namelen,
        byte[] oldp,
        ref IntPtr oldlenp,
        IntPtr newp,
        IntPtr newlen);

    [DllImport("libc")]
    private static extern int sysctl(
        int[] name,
        int namelen,
        int[] oldp,
        ref IntPtr oldlenp,
        IntPtr newp,
        IntPtr newlen);

    [StructLayout(LayoutKind.Sequential)]
    private struct vnode_info_path
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 152)]
        public byte[] vip_vi;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 1024)]
        public string vip_path;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct proc_vnodepathinfo
    {
        public vnode_info_path pvi_cdir;
        public vnode_info_path pvi_rdir;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct proc_bsdinfo
    {
        public uint pbi_flags;
        public uint pbi_status;
        public uint pbi_xstatus;
        public uint pbi_pid;
        public uint pbi_ppid;
        public uint pbi_uid;
        public uint pbi_gid;
        public uint pbi_ruid;
        public uint pbi_rgid;
        public uint pbi_svuid;
        public uint pbi_svgid;
        public uint rfu_1;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] pbi_comm;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 1024)]
        public byte[] pbi_name;
        public uint pbi_nfiles;
        public uint pbi_pgid;
        public uint pbi_pjobc;
        public uint e_tdev;
        public uint e_tpgid;
        public int pbi_nice;
        public ulong pbi_start_tvsec;
        public ulong pbi_start_tvusec;
    }

    #endregion
}
#endif
