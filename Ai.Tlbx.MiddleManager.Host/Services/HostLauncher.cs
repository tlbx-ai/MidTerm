#if WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;
using static Ai.Tlbx.MiddleManager.Host.Log;

namespace Ai.Tlbx.MiddleManager.Host.Services;

/// <summary>
/// Runs as SYSTEM service, spawns mm-host --service as the interactive user.
/// This ensures ConPTY is created in the user's session, fixing TUI app support.
/// </summary>
public sealed class HostLauncher : IAsyncDisposable
{
    private const int MaxBackoffDelayMs = 30_000;
    private const int StableRunDurationMs = 60_000;

    private readonly int _port;
    private readonly string _bindAddress;
    private IntPtr _processHandle;
    private int _processId;
    private int _restartCount;
    private DateTime _lastStart;
    private CancellationTokenSource? _stableCheckCts;
    private bool _disposed;

    public HostLauncher(int port = 2000, string bindAddress = "0.0.0.0")
    {
        _port = port;
        _bindAddress = bindAddress;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (!SpawnHostAsUser())
                {
                    Write("Failed to spawn mm-host as user, retrying in 5 seconds...");
                    await Task.Delay(5000, cancellationToken).ConfigureAwait(false);
                    continue;
                }

                _lastStart = DateTime.UtcNow;
                StartStableCheck();

                // Wait for process to exit
                while (!cancellationToken.IsCancellationRequested)
                {
                    var result = WaitForSingleObject(_processHandle, 1000);
                    if (result == WAIT_OBJECT_0)
                    {
                        break;
                    }
                }

                if (cancellationToken.IsCancellationRequested)
                {
                    break;
                }

                GetExitCodeProcess(_processHandle, out var exitCode);
                var runtime = DateTime.UtcNow - _lastStart;
                Write($"mm-host (user mode) exited with code {exitCode} after {runtime.TotalSeconds:F1}s");

                CloseHandle(_processHandle);
                _processHandle = IntPtr.Zero;

                _restartCount++;
                var delay = CalculateBackoffDelay();
                Write($"Restarting mm-host in {delay}ms (attempt {_restartCount})...");
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Write($"Launcher error: {ex.Message}");
                await Task.Delay(1000, cancellationToken).ConfigureAwait(false);
            }
        }

        StopHost();
    }

    private bool SpawnHostAsUser()
    {
        var hostPath = Environment.ProcessPath;
        if (string.IsNullOrEmpty(hostPath) || !File.Exists(hostPath))
        {
            Write($"mm-host not found at: {hostPath}");
            return false;
        }

        // Get the active console session (the logged-in user's session)
        var sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF)
        {
            Write("No active console session found");
            return false;
        }

        // Get the user's token
        if (!WTSQueryUserToken(sessionId, out var userToken))
        {
            var error = Marshal.GetLastWin32Error();
            Write($"WTSQueryUserToken failed: {error}");
            return false;
        }

        try
        {
            // Create environment block for the user
            if (!CreateEnvironmentBlock(out var envBlock, userToken, false))
            {
                Write($"CreateEnvironmentBlock failed: {Marshal.GetLastWin32Error()}");
                return false;
            }

            try
            {
                var si = new STARTUPINFO();
                si.cb = Marshal.SizeOf<STARTUPINFO>();
                si.lpDesktop = Marshal.StringToHGlobalUni("winsta0\\default");

                try
                {
                    var commandLine = $"\"{hostPath}\" --service --port {_port} --bind {_bindAddress}";

                    var result = CreateProcessAsUser(
                        userToken,
                        null,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        false,
                        CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE,
                        envBlock,
                        Path.GetDirectoryName(hostPath),
                        ref si,
                        out var pi);

                    if (!result)
                    {
                        var error = Marshal.GetLastWin32Error();
                        Write($"CreateProcessAsUser failed: {error}");
                        return false;
                    }

                    _processHandle = pi.hProcess;
                    _processId = pi.dwProcessId;
                    CloseHandle(pi.hThread);

                    Write($"Spawned mm-host as user (PID: {_processId}, Session: {sessionId})");
                    return true;
                }
                finally
                {
                    Marshal.FreeHGlobal(si.lpDesktop);
                }
            }
            finally
            {
                DestroyEnvironmentBlock(envBlock);
            }
        }
        finally
        {
            CloseHandle(userToken);
        }
    }

    private void StartStableCheck()
    {
        _stableCheckCts?.Cancel();
        _stableCheckCts = new CancellationTokenSource();
        var token = _stableCheckCts.Token;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(StableRunDurationMs, token).ConfigureAwait(false);
                if (_processHandle != IntPtr.Zero)
                {
                    var result = WaitForSingleObject(_processHandle, 0);
                    if (result != WAIT_OBJECT_0)
                    {
                        if (_restartCount > 0)
                        {
                            Write($"mm-host stable for {StableRunDurationMs / 1000}s, resetting restart counter");
                        }
                        _restartCount = 0;
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
        }, token);
    }

    private int CalculateBackoffDelay()
    {
        var exponent = Math.Min(_restartCount, 5);
        return Math.Min(MaxBackoffDelayMs, 1000 * (1 << exponent));
    }

    private void StopHost()
    {
        _stableCheckCts?.Cancel();

        if (_processHandle == IntPtr.Zero)
        {
            return;
        }

        var result = WaitForSingleObject(_processHandle, 0);
        if (result == WAIT_OBJECT_0)
        {
            CloseHandle(_processHandle);
            _processHandle = IntPtr.Zero;
            return;
        }

        Write("Stopping mm-host (user mode)...");
        try
        {
            TerminateProcess(_processHandle, 0);
            WaitForSingleObject(_processHandle, 5000);
        }
        catch (Exception ex)
        {
            Write($"Error stopping mm-host: {ex.Message}");
        }
        finally
        {
            CloseHandle(_processHandle);
            _processHandle = IntPtr.Zero;
        }
    }

    public ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return ValueTask.CompletedTask;
        }
        _disposed = true;

        StopHost();
        _stableCheckCts?.Dispose();
        return ValueTask.CompletedTask;
    }

    #region P/Invoke

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint WAIT_OBJECT_0 = 0;

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr hToken,
        string? lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    #endregion
}
#endif
