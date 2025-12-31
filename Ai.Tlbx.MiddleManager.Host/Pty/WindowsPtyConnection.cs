#if WINDOWS
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Microsoft.Win32.SafeHandles;
using static Ai.Tlbx.MiddleManager.Host.Pty.ConPtyNative;

namespace Ai.Tlbx.MiddleManager.Host.Pty;

[SupportedOSPlatform("windows")]
public sealed class WindowsPtyConnection : IPtyConnection
{
    private readonly object _lock = new();
    private IntPtr _pseudoConsoleHandle;
    private IntPtr _processHandle;
    private IntPtr _threadHandle;
    private IntPtr _attributeList;
    private SafeFileHandle? _inputWriteHandle;
    private SafeFileHandle? _outputReadHandle;
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

    public int Pid { get; private set; }

    public bool IsRunning
    {
        get
        {
            if (_disposed || _processHandle == IntPtr.Zero)
            {
                return false;
            }

            try
            {
                if (GetExitCodeProcess(_processHandle, out var code))
                {
                    return code == STILL_ACTIVE;
                }
            }
            catch { }

            return false;
        }
    }

    public int? ExitCode
    {
        get
        {
            if (_processHandle == IntPtr.Zero)
            {
                return null;
            }

            try
            {
                if (GetExitCodeProcess(_processHandle, out var code))
                {
                    return code == STILL_ACTIVE ? null : (int)code;
                }
            }
            catch { }

            return null;
        }
    }

    private WindowsPtyConnection() { }

    public static WindowsPtyConnection Start(
        string app,
        string[] args,
        string workingDirectory,
        int cols,
        int rows,
        IDictionary<string, string>? environment = null,
        string? runAsUserSid = null)
    {
        // runAsUserSid is ignored - mm-host now runs as user (spawned by launcher)
        // so ConPTY is created in the correct session automatically

        ArgumentException.ThrowIfNullOrWhiteSpace(app);
        ArgumentNullException.ThrowIfNull(args);
        ArgumentException.ThrowIfNullOrWhiteSpace(workingDirectory);
        ArgumentOutOfRangeException.ThrowIfLessThan(cols, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(rows, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(cols, short.MaxValue);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(rows, short.MaxValue);

        var connection = new WindowsPtyConnection();
        try
        {
            connection.StartInternal(app, args, workingDirectory, cols, rows, environment);
            return connection;
        }
        catch
        {
            connection.Dispose();
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
        SafeFileHandle? inputReadHandle = null;
        SafeFileHandle? outputWriteHandle = null;

        try
        {
            if (!CreatePipe(out inputReadHandle, out var inputWriteHandle, IntPtr.Zero, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create input pipe");
            }
            _inputWriteHandle = inputWriteHandle;

            if (!CreatePipe(out var outputReadHandle, out outputWriteHandle, IntPtr.Zero, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create output pipe");
            }
            _outputReadHandle = outputReadHandle;

            var size = new Coord((short)cols, (short)rows);
            var hr = CreatePseudoConsole(size, inputReadHandle, outputWriteHandle, 0, out _pseudoConsoleHandle);
            if (hr != 0)
            {
                throw new Win32Exception(hr, "Failed to create pseudo console");
            }

            inputReadHandle.Dispose();
            inputReadHandle = null;
            outputWriteHandle.Dispose();
            outputWriteHandle = null;

            var attrSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
            _attributeList = Marshal.AllocHGlobal(attrSize);

            if (!InitializeProcThreadAttributeList(_attributeList, 1, 0, ref attrSize))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to initialize attribute list");
            }

            if (!UpdateProcThreadAttribute(
                _attributeList,
                0,
                (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                _pseudoConsoleHandle,
                (IntPtr)IntPtr.Size,
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to update attribute");
            }

            var commandLine = BuildCommandLine(app, args);

            IntPtr envPtr = IntPtr.Zero;
            try
            {
                var startupInfo = new StartupInfoEx
                {
                    StartupInfo = new StartupInfo { cb = Marshal.SizeOf<StartupInfoEx>() },
                    lpAttributeList = _attributeList
                };

                var envBlock = BuildEnvironmentBlock(environment);
                if (envBlock is not null)
                {
                    envPtr = Marshal.StringToHGlobalUni(envBlock);
                }

                var success = CreateProcess(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                    envPtr,
                    workingDirectory,
                    ref startupInfo,
                    out var processInfo);

                if (!success)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create process");
                }

                _processHandle = processInfo.hProcess;
                _threadHandle = processInfo.hThread;
                Pid = processInfo.dwProcessId;
            }
            finally
            {
                if (envPtr != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(envPtr);
                }
            }

            _writerStream = new FileStream(_inputWriteHandle, FileAccess.Write, 4096, false);
            _readerStream = new FileStream(_outputReadHandle, FileAccess.Read, 4096, false);
        }
        catch
        {
            inputReadHandle?.Dispose();
            outputWriteHandle?.Dispose();
            throw;
        }
    }

    private static string BuildCommandLine(string app, string[] args)
    {
        var sb = new StringBuilder();

        if (app.Contains(' '))
        {
            sb.Append('"').Append(app).Append('"');
        }
        else
        {
            sb.Append(app);
        }

        foreach (var arg in args)
        {
            sb.Append(' ');
            if (arg.Contains(' ') || arg.Contains('"'))
            {
                sb.Append('"').Append(arg.Replace("\"", "\\\"")).Append('"');
            }
            else
            {
                sb.Append(arg);
            }
        }

        return sb.ToString();
    }

    private static string? BuildEnvironmentBlock(IDictionary<string, string>? environment)
    {
        if (environment is null || environment.Count == 0)
        {
            return null;
        }

        var sb = new StringBuilder();
        foreach (var kvp in environment)
        {
            sb.Append(kvp.Key).Append('=').Append(kvp.Value).Append('\0');
        }
        sb.Append('\0');
        return sb.ToString();
    }

    public void Resize(int cols, int rows)
    {
        if (_disposed)
        {
            return;
        }

        if (cols < 1 || cols > short.MaxValue || rows < 1 || rows > short.MaxValue)
        {
            return;
        }

        lock (_lock)
        {
            if (_pseudoConsoleHandle != IntPtr.Zero)
            {
                try
                {
                    var size = new Coord((short)cols, (short)rows);
                    ResizePseudoConsole(_pseudoConsoleHandle, size);
                }
                catch { }
            }
        }
    }

    public void Kill()
    {
        if (_disposed)
        {
            return;
        }

        lock (_lock)
        {
            if (_processHandle != IntPtr.Zero)
            {
                try
                {
                    TerminateProcess(_processHandle, 1);
                }
                catch { }
            }
        }
    }

    public bool WaitForExit(int milliseconds)
    {
        if (_disposed || _processHandle == IntPtr.Zero)
        {
            return true;
        }

        try
        {
            var result = WaitForSingleObject(_processHandle, (uint)milliseconds);
            return result == WAIT_OBJECT_0;
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

            try { _writerStream?.Dispose(); } catch { }
            try { _readerStream?.Dispose(); } catch { }
            try { _inputWriteHandle?.Dispose(); } catch { }
            try { _outputReadHandle?.Dispose(); } catch { }

            if (_attributeList != IntPtr.Zero)
            {
                try
                {
                    DeleteProcThreadAttributeList(_attributeList);
                    Marshal.FreeHGlobal(_attributeList);
                }
                catch { }
                _attributeList = IntPtr.Zero;
            }

            if (_pseudoConsoleHandle != IntPtr.Zero)
            {
                try { ClosePseudoConsole(_pseudoConsoleHandle); } catch { }
                _pseudoConsoleHandle = IntPtr.Zero;
            }

            if (_threadHandle != IntPtr.Zero)
            {
                try { CloseHandle(_threadHandle); } catch { }
                _threadHandle = IntPtr.Zero;
            }

            if (_processHandle != IntPtr.Zero)
            {
                try { CloseHandle(_processHandle); } catch { }
                _processHandle = IntPtr.Zero;
            }
        }

        GC.SuppressFinalize(this);
    }

    ~WindowsPtyConnection()
    {
        Dispose();
    }
}
#endif
