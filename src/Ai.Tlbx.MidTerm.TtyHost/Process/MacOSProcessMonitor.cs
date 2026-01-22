#if MACOS
using System.Runtime.InteropServices;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.TtyHost.Process;

/// <summary>
/// macOS process monitor using kqueue for event-driven child process detection.
/// Falls back to timer for CWD changes since kqueue can't watch filesystem operations.
/// </summary>
public sealed class MacOSProcessMonitor : IProcessMonitor
{
    private int _shellPid;
    private int _kq = -1;
    private int? _currentChildPid;
    private string? _currentCwd;
    private Thread? _eventThread;
    private Timer? _cwdTimer;
    private volatile bool _disposed;

    public event Action<ForegroundProcessInfo>? OnForegroundChanged;

    public void StartMonitoring(int shellPid)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(MacOSProcessMonitor));

        _shellPid = shellPid;
        _kq = kqueue();

        if (_kq < 0)
        {
            Log.Warn(() => "kqueue() failed, falling back to polling");
            _cwdTimer = new Timer(_ => Poll(), null, 0, 500);
            return;
        }

        RegisterWatch(_shellPid);

        _eventThread = new Thread(EventLoop) { IsBackground = true, Name = "macOS-kqueue" };
        _eventThread.Start();

        // Timer for CWD changes (kqueue can't watch this)
        _cwdTimer = new Timer(_ => CheckCwdChange(), null, 500, 500);

        // Initial state
        RefreshForeground();
    }

    public void StopMonitoring()
    {
        _disposed = true;
        _cwdTimer?.Dispose();
        _cwdTimer = null;

        if (_kq >= 0)
        {
            close(_kq);
            _kq = -1;
        }

        _eventThread?.Join(1000);
        _eventThread = null;
    }

    public ForegroundProcessInfo GetCurrentForeground()
    {
        var childPid = GetFirstDirectChild(_shellPid);
        if (childPid is null)
        {
            return new ForegroundProcessInfo
            {
                Pid = _shellPid,
                Name = "shell",
                Cwd = GetShellCwd()
            };
        }

        return new ForegroundProcessInfo
        {
            Pid = childPid.Value,
            Name = GetProcessName(childPid.Value) ?? "unknown",
            CommandLine = GetProcessCommandLine(childPid.Value),
            Cwd = GetProcessCwd(childPid.Value) ?? GetShellCwd()
        };
    }

    public string? GetShellCwd() => GetProcessCwd(_shellPid);

    private void RegisterWatch(int pid)
    {
        var ev = new kevent_s
        {
            ident = (ulong)pid,
            filter = EVFILT_PROC,
            flags = EV_ADD | EV_ENABLE,
            fflags = NOTE_FORK | NOTE_EXIT | NOTE_EXEC,
            data = 0,
            udata = IntPtr.Zero
        };

        kevent(_kq, ref ev, 1, IntPtr.Zero, 0, IntPtr.Zero);
    }

    private void EventLoop()
    {
        var events = new kevent_s[4];
        var timeout = new timespec { tv_sec = 1, tv_nsec = 0 };

        while (!_disposed)
        {
            try
            {
                var count = kevent(_kq, IntPtr.Zero, 0, events, events.Length, ref timeout);
                if (count > 0)
                {
                    RefreshForeground();
                }
            }
            catch (Exception ex)
            {
                if (!_disposed)
                    Log.Warn(() => $"kqueue event loop error: {ex.Message}");
            }
        }
    }

    private void Poll()
    {
        if (_disposed) return;

        try
        {
            var childPid = GetFirstDirectChild(_shellPid);
            var cwd = GetShellCwd();

            if (childPid != _currentChildPid || cwd != _currentCwd)
            {
                _currentChildPid = childPid;
                _currentCwd = cwd;
                OnForegroundChanged?.Invoke(GetCurrentForeground());
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Process poll error: {ex.Message}");
        }
    }

    private void CheckCwdChange()
    {
        if (_disposed) return;

        try
        {
            var cwd = GetShellCwd();
            if (cwd != _currentCwd)
            {
                _currentCwd = cwd;
                OnForegroundChanged?.Invoke(GetCurrentForeground());
            }
        }
        catch { }
    }

    private void RefreshForeground()
    {
        if (_disposed) return;

        var childPid = GetFirstDirectChild(_shellPid);
        var cwd = GetShellCwd();

        if (childPid != _currentChildPid || cwd != _currentCwd)
        {
            _currentChildPid = childPid;
            _currentCwd = cwd;
            OnForegroundChanged?.Invoke(GetCurrentForeground());
        }
    }

    private static int? GetFirstDirectChild(int parentPid)
    {
        var count = proc_listchildpids(parentPid, null, 0);
        if (count <= 0) return null;

        var pids = new int[count];
        var actualCount = proc_listchildpids(parentPid, pids, count * sizeof(int));
        if (actualCount <= 0) return null;

        var numPids = actualCount / sizeof(int);
        return numPids > 0 && pids[0] > 0 ? pids[0] : null;
    }

    private static string? GetProcessName(int pid)
    {
        var buffer = new byte[PROC_PIDPATHINFO_MAXSIZE];
        var len = proc_pidpath(pid, buffer, buffer.Length);
        if (len <= 0) return null;
        return Path.GetFileName(Encoding.UTF8.GetString(buffer, 0, len));
    }

    private static string? GetProcessCwd(int pid)
    {
        var vnodeInfo = new proc_vnodepathinfo();
        var size = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, ref vnodeInfo, Marshal.SizeOf<proc_vnodepathinfo>());
        return size > 0 ? vnodeInfo.pvi_cdir.vip_path?.TrimEnd('\0') : null;
    }

    private static string? GetProcessCommandLine(int pid)
    {
        try
        {
            var argmax = new int[1];
            var size = (IntPtr)sizeof(int);
            var mib = new int[] { CTL_KERN, KERN_ARGMAX };

            if (sysctl(mib, 2, argmax, ref size, IntPtr.Zero, IntPtr.Zero) != 0)
                return null;

            var buffer = new byte[argmax[0]];
            size = (IntPtr)buffer.Length;
            mib = new int[] { CTL_KERN, KERN_PROCARGS2, pid };

            if (sysctl(mib, 3, buffer, ref size, IntPtr.Zero, IntPtr.Zero) != 0)
                return null;

            if ((int)size < 4) return null;

            var argc = BitConverter.ToInt32(buffer, 0);
            var pos = 4;

            // Skip executable path
            while (pos < (int)size && buffer[pos] != 0) pos++;
            while (pos < (int)size && buffer[pos] == 0) pos++;

            // Collect args (skip first which is command name)
            var args = new List<string>();
            for (int i = 0; i < argc && pos < (int)size; i++)
            {
                var start = pos;
                while (pos < (int)size && buffer[pos] != 0) pos++;
                if (pos > start && i > 0) // Skip first arg (command name)
                    args.Add(Encoding.UTF8.GetString(buffer, start, pos - start));
                pos++;
            }

            return args.Count > 0 ? string.Join(" ", args) : null;
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopMonitoring();
    }

    #region Native Interop

    private const short EVFILT_PROC = -5;
    private const ushort EV_ADD = 0x0001;
    private const ushort EV_ENABLE = 0x0004;
    private const uint NOTE_EXIT = 0x80000000;
    private const uint NOTE_FORK = 0x40000000;
    private const uint NOTE_EXEC = 0x20000000;

    private const int PROC_PIDVNODEPATHINFO = 9;
    private const int PROC_PIDPATHINFO_MAXSIZE = 4096;
    private const int CTL_KERN = 1;
    private const int KERN_ARGMAX = 8;
    private const int KERN_PROCARGS2 = 49;

    [StructLayout(LayoutKind.Sequential)]
    private struct kevent_s
    {
        public ulong ident;
        public short filter;
        public ushort flags;
        public uint fflags;
        public long data;
        public IntPtr udata;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct timespec
    {
        public long tv_sec;
        public long tv_nsec;
    }

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

    [DllImport("libc")]
    private static extern int kqueue();

    [DllImport("libc")]
    private static extern int kevent(int kq, ref kevent_s changelist, int nchanges, IntPtr eventlist, int nevents, IntPtr timeout);

    [DllImport("libc")]
    private static extern int kevent(int kq, IntPtr changelist, int nchanges, [Out] kevent_s[] eventlist, int nevents, ref timespec timeout);

    [DllImport("libc")]
    private static extern int close(int fd);

    [DllImport("libproc.dylib")]
    private static extern int proc_pidinfo(int pid, int flavor, ulong arg, ref proc_vnodepathinfo buffer, int bufferSize);

    [DllImport("libproc.dylib")]
    private static extern int proc_pidpath(int pid, byte[] buffer, int bufferSize);

    [DllImport("libproc.dylib")]
    private static extern int proc_listchildpids(int ppid, int[]? buffer, int bufferSize);

    [DllImport("libc")]
    private static extern int sysctl(int[] name, int namelen, byte[] oldp, ref IntPtr oldlenp, IntPtr newp, IntPtr newlen);

    [DllImport("libc")]
    private static extern int sysctl(int[] name, int namelen, int[] oldp, ref IntPtr oldlenp, IntPtr newp, IntPtr newlen);

    #endregion
}
#endif
