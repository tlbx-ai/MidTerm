#if MACOS
using System.Runtime.InteropServices;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.TtyHost.Process;

/// <summary>
/// macOS process monitor using kqueue for event-driven detection
/// and tcgetpgrp for foreground process identification.
/// </summary>
public sealed class MacOSProcessMonitor : IProcessMonitor
{
    private int _shellPid;
    private int _ptyMasterFd = -1;
    private int _kq = -1;
    private int? _currentForegroundPid;
    private string? _currentCwd;
    private string? _currentForegroundCwd;
    private readonly object _stateLock = new();
    private Thread? _eventThread;
    private Timer? _pollTimer;
    private volatile bool _disposed;

    // Reusable buffers (thread-safe via ThreadStatic)
    [ThreadStatic]
    private static byte[]? _pathBuffer;
    [ThreadStatic]
    private static byte[]? _argmaxBuffer;

    private static byte[] PathBuffer => _pathBuffer ??= new byte[PROC_PIDPATHINFO_MAXSIZE];
    private static byte[] ArgmaxBuffer => _argmaxBuffer ??= new byte[256 * 1024];

    public event Action<ForegroundProcessInfo>? OnForegroundChanged;

    public void StartMonitoring(int shellPid, int ptyMasterFd = -1)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(MacOSProcessMonitor));

        _shellPid = shellPid;
        _ptyMasterFd = ptyMasterFd;
        _kq = kqueue();

        if (_kq < 0)
        {
            Log.Warn(() => "kqueue() failed, falling back to polling");
            _pollTimer = new Timer(_ => RefreshForeground(), null, 0, 500);
            return;
        }

        RegisterWatch(_shellPid);

        _eventThread = new Thread(EventLoop) { IsBackground = true, Name = "macOS-kqueue" };
        _eventThread.Start();

        // Poll timer for changes kqueue can't detect (CWD changes, child exit)
        _pollTimer = new Timer(_ => RefreshForeground(), null, 500, 500);

        // Initial state
        RefreshForeground();
    }

    public void StopMonitoring()
    {
        _disposed = true;
        _pollTimer?.Dispose();
        _pollTimer = null;

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
        var fgPid = GetForegroundPid();
        if (fgPid is null)
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
            Pid = fgPid.Value,
            Name = GetProcessName(fgPid.Value) ?? "unknown",
            CommandLine = GetProcessCommandLine(fgPid.Value),
            Cwd = GetProcessCwd(fgPid.Value) ?? GetShellCwd()
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
        var timeout = new Timespec { tv_sec = 1, tv_nsec = 0 };

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

    private void RefreshForeground()
    {
        if (_disposed) return;

        try
        {
            var fgPid = GetForegroundPid();
            var cwd = GetShellCwd();
            var fgCwd = fgPid.HasValue ? GetProcessCwd(fgPid.Value) : null;

            bool shouldNotify;
            lock (_stateLock)
            {
                shouldNotify = fgPid != _currentForegroundPid || cwd != _currentCwd || fgCwd != _currentForegroundCwd;
                if (shouldNotify)
                {
                    _currentForegroundPid = fgPid;
                    _currentCwd = cwd;
                    _currentForegroundCwd = fgCwd;
                }
            }

            if (shouldNotify)
            {
                OnForegroundChanged?.Invoke(GetCurrentForeground());
            }
        }
        catch (Exception ex)
        {
            if (!_disposed)
                Log.Warn(() => $"Process refresh error: {ex.Message}");
        }
    }

    /// <summary>
    /// Get the foreground process PID using tcgetpgrp on the PTY master fd.
    /// Returns null when the shell itself is in the foreground (idle).
    /// </summary>
    private int? GetForegroundPid()
    {
        if (_ptyMasterFd < 0) return null;

        var pgid = tcgetpgrp(_ptyMasterFd);
        if (pgid <= 0 || pgid == _shellPid) return null;

        return pgid;
    }

    private static string? GetProcessName(int pid)
    {
        var buffer = PathBuffer;
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
            var buffer = ArgmaxBuffer;
            var size = (IntPtr)buffer.Length;
            var mib = new int[] { CTL_KERN, KERN_PROCARGS2, pid };

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
                if (pos > start && i > 0)
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
    private struct Timespec
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
    private static extern int kevent(int kq, IntPtr changelist, int nchanges, [Out] kevent_s[] eventlist, int nevents, ref Timespec timeout);

    [DllImport("libc")]
    private static extern int close(int fd);

    [DllImport("libc")]
    private static extern int tcgetpgrp(int fd);

    [DllImport("libproc.dylib")]
    private static extern int proc_pidinfo(int pid, int flavor, ulong arg, ref proc_vnodepathinfo buffer, int bufferSize);

    [DllImport("libproc.dylib")]
    private static extern int proc_pidpath(int pid, byte[] buffer, int bufferSize);

    [DllImport("libc")]
    private static extern int sysctl(int[] name, int namelen, byte[] oldp, ref IntPtr oldlenp, IntPtr newp, IntPtr newlen);

    #endregion
}
#endif
