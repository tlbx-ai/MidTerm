#if !WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.TtyHost.Pty;

public sealed class UnixPty : IPtyConnection
{
    private readonly object _lock = new();
    private int _masterFd = -1;
    private Process? _process;
    private Microsoft.Win32.SafeHandles.SafeFileHandle? _masterHandle; // Single handle for both streams
    private FileStream? _writerStream;
    private FileStream? _readerStream;
    private bool _disposed;

    public Stream WriterStream
    {
        get
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _writerStream ?? throw new InvalidOperationException("Writer stream not initialized");
        }
    }

    public Stream ReaderStream
    {
        get
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _readerStream ?? throw new InvalidOperationException("Reader stream not initialized");
        }
    }

    public int Pid => _process?.Id ?? -1;

    public bool IsRunning
    {
        get
        {
            if (_disposed || _process is null)
            {
                return false;
            }
            try
            {
                return !_process.HasExited;
            }
            catch
            {
                return false;
            }
        }
    }

    public int? ExitCode
    {
        get
        {
            if (_process is null)
            {
                return null;
            }
            try
            {
                return _process.HasExited ? _process.ExitCode : null;
            }
            catch
            {
                return null;
            }
        }
    }

    private UnixPty() { }

    public static UnixPty Start(
        string app,
        string[] args,
        string workingDirectory,
        int cols,
        int rows,
        IDictionary<string, string>? environment = null)
    {
        var pty = new UnixPty();
        try
        {
            pty.StartInternal(app, args, workingDirectory, cols, rows, environment);
            return pty;
        }
        catch
        {
            pty.Dispose();
            throw;
        }
    }

    private void StartInternal(
        string app,
        string[] args,
        string workingDirectory,
        int cols,
        int rows,
        IDictionary<string, string>? environment)
    {
        _masterFd = posix_openpt(O_RDWR | O_NOCTTY);
        if (_masterFd < 0)
        {
            throw new InvalidOperationException($"posix_openpt failed: {Marshal.GetLastWin32Error()}");
        }

        if (grantpt(_masterFd) != 0)
        {
            throw new InvalidOperationException($"grantpt failed: {Marshal.GetLastWin32Error()}");
        }

        if (unlockpt(_masterFd) != 0)
        {
            throw new InvalidOperationException($"unlockpt failed: {Marshal.GetLastWin32Error()}");
        }

        var slaveNamePtr = ptsname(_masterFd);
        if (slaveNamePtr == IntPtr.Zero)
        {
            throw new InvalidOperationException("ptsname failed");
        }
        var slaveName = Marshal.PtrToStringAnsi(slaveNamePtr)!;

        var winSize = new WinSize
        {
            ws_col = (ushort)cols,
            ws_row = (ushort)rows
        };
        ioctl(_masterFd, TIOCSWINSZ, ref winSize);

        // Use a single SafeFileHandle for both streams to avoid double-close risk
        // ownsHandle: false because we manage the FD lifecycle manually with close()
        _masterHandle = new Microsoft.Win32.SafeHandles.SafeFileHandle((IntPtr)_masterFd, ownsHandle: false);
        _writerStream = new FileStream(_masterHandle, FileAccess.Write, bufferSize: 4096, isAsync: false);
        _readerStream = new FileStream(_masterHandle, FileAccess.Read, bufferSize: 4096, isAsync: false);

        ProcessStartInfo psi;
        var argsString = args.Length > 0 ? " " + string.Join(" ", args) : "";

        if (OperatingSystem.IsMacOS())
        {
            var pyScript = $"import os; os.setsid(); fd=os.open('{slaveName}',os.O_RDWR); " +
                           "os.dup2(fd,0); os.dup2(fd,1); os.dup2(fd,2); os.close(fd); " +
                           $"os.execvp('{app}',['{app}'" + (args.Length > 0 ? ", " + string.Join(", ", args.Select(a => $"'{a}'")) : "") + "])";
            psi = new ProcessStartInfo
            {
                FileName = "/usr/bin/python3",
                Arguments = $"-c \"{pyScript}\""
            };
        }
        else
        {
            var execCmd = $"exec setsid {app}{argsString} <'{slaveName}' >'{slaveName}' 2>&1";
            psi = new ProcessStartInfo
            {
                FileName = "/bin/sh",
                Arguments = $"-c \"{execCmd}\""
            };
        }

        psi.WorkingDirectory = Directory.Exists(workingDirectory)
            ? workingDirectory
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = false;
        psi.RedirectStandardOutput = false;
        psi.RedirectStandardError = false;

        if (environment is not null)
        {
            foreach (var kvp in environment)
            {
                psi.Environment[kvp.Key] = kvp.Value;
            }
        }

        _process = Process.Start(psi);
        if (_process is null)
        {
            throw new InvalidOperationException("Failed to start process");
        }
    }

    public void Resize(int cols, int rows)
    {
        if (_disposed || _masterFd < 0)
        {
            return;
        }

        lock (_lock)
        {
            if (_masterFd >= 0)
            {
                var winSize = new WinSize
                {
                    ws_col = (ushort)cols,
                    ws_row = (ushort)rows
                };
                ioctl(_masterFd, TIOCSWINSZ, ref winSize);
            }
        }
    }

    public void Kill()
    {
        if (_disposed || _process is null)
        {
            return;
        }

        lock (_lock)
        {
            try
            {
                if (!_process.HasExited)
                {
                    _process.Kill(entireProcessTree: true);
                }
            }
            catch { }
        }
    }

    public bool WaitForExit(int milliseconds)
    {
        if (_disposed || _process is null)
        {
            return true;
        }
        try
        {
            return _process.WaitForExit(milliseconds);
        }
        catch
        {
            return true;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;

            // Kill process FIRST so it can flush buffers before FD is closed
            if (_process is not null)
            {
                try
                {
                    if (!_process.HasExited)
                    {
                        _process.Kill(entireProcessTree: true);
                        _process.WaitForExit(1000);
                    }
                }
                catch { }
            }

            // Dispose streams before closing FD
            try { _writerStream?.Dispose(); } catch { }
            try { _readerStream?.Dispose(); } catch { }
            _writerStream = null;
            _readerStream = null;

            // Dispose handle (doesn't close FD since ownsHandle: false)
            try { _masterHandle?.Dispose(); } catch { }
            _masterHandle = null;

            // Close the FD manually
            if (_masterFd >= 0)
            {
                try { close(_masterFd); } catch { }
                _masterFd = -1;
            }

            // Finally dispose process object
            try { _process?.Dispose(); } catch { }
            _process = null;
        }

        GC.SuppressFinalize(this);
    }

    ~UnixPty()
    {
        Dispose();
    }

    #region Native Interop

    [StructLayout(LayoutKind.Sequential)]
    private struct WinSize
    {
        public ushort ws_row;
        public ushort ws_col;
        public ushort ws_xpixel;
        public ushort ws_ypixel;
    }

    private static readonly nuint TIOCSWINSZ = OperatingSystem.IsMacOS()
        ? 0x80087467
        : 0x5414;

    private const int O_RDWR = 2;
    private const int O_NOCTTY = 256;

    [DllImport("libc", SetLastError = true)]
    private static extern int posix_openpt(int flags);

    [DllImport("libc", SetLastError = true)]
    private static extern int grantpt(int fd);

    [DllImport("libc", SetLastError = true)]
    private static extern int unlockpt(int fd);

    [DllImport("libc", SetLastError = true)]
    private static extern IntPtr ptsname(int fd);

    [DllImport("libc", SetLastError = true)]
    private static extern int ioctl(int fd, nuint request, ref WinSize winsize);

    [DllImport("libc", SetLastError = true)]
    private static extern int close(int fd);

    #endregion
}
#endif
