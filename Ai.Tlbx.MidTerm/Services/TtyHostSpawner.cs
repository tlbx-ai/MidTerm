using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Logging;
#if WINDOWS
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
#endif

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Spawns mthost processes. Cross-platform with special handling for Windows service mode.
/// </summary>
public static class TtyHostSpawner
{
    private static readonly string TtyHostPath = GetTtyHostPath();

    /// <summary>
    /// Gets the expected full path to mthost for this mt installation.
    /// Used to filter discovered processes to only those from this installation.
    /// </summary>
    public static string ExpectedTtyHostPath => TtyHostPath;

    public static string? GetTtyHostVersion()
    {
        if (!File.Exists(TtyHostPath))
        {
            return null;
        }

        try
        {
            var versionInfo = FileVersionInfo.GetVersionInfo(TtyHostPath);
            return versionInfo.ProductVersion ?? versionInfo.FileVersion;
        }
        catch
        {
            return null;
        }
    }

    public static bool SpawnTtyHost(
        string sessionId,
        string? shellType,
        string? workingDirectory,
        int cols,
        int rows,
        LogSeverity logLevel,
        string? runAsUser,
        out int processId)
    {
        processId = 0;

        if (!File.Exists(TtyHostPath))
        {
            Console.WriteLine($"[TtyHostSpawner] mthost not found at: {TtyHostPath}");
            return false;
        }

        var args = BuildArgs(sessionId, shellType, workingDirectory, cols, rows, logLevel);

#pragma warning disable CA1416 // Validate platform compatibility (compile-time guard via WINDOWS constant)
#if WINDOWS
        return SpawnWindows(args, out processId);
#else
        return SpawnUnix(args, runAsUser, out processId);
#endif
#pragma warning restore CA1416
    }

    private static string BuildArgs(string sessionId, string? shellType, string? workingDirectory, int cols, int rows, LogSeverity logLevel)
    {
        var args = $"--session {sessionId} --cols {cols} --rows {rows} --loglevel {logLevel.ToString().ToLowerInvariant()}";
        if (!string.IsNullOrEmpty(shellType))
        {
            args += $" --shell {shellType}";
        }
        if (!string.IsNullOrEmpty(workingDirectory))
        {
            args += $" --cwd \"{workingDirectory}\"";
        }
        return args;
    }

#if !WINDOWS
    private static bool SpawnUnix(string args, string? runAsUser, out int processId)
    {
        processId = 0;

        try
        {
            ProcessStartInfo psi;

            // If running as root and runAsUser is configured, use sudo -u to drop privileges
            var isRoot = Environment.GetEnvironmentVariable("USER") == "root" ||
                         Environment.GetEnvironmentVariable("EUID") == "0" ||
                         Environment.GetEnvironmentVariable("SUDO_USER") is not null;

            // If runAsUser not configured but we're root, try SUDO_USER as fallback
            // This handles cases where service settings don't have runAsUser set
            var effectiveRunAsUser = runAsUser;
            if (string.IsNullOrEmpty(effectiveRunAsUser) && isRoot)
            {
                effectiveRunAsUser = Environment.GetEnvironmentVariable("SUDO_USER");
            }

            if (isRoot && !string.IsNullOrEmpty(effectiveRunAsUser))
            {
                psi = new ProcessStartInfo
                {
                    FileName = "sudo",
                    Arguments = $"-u {effectiveRunAsUser} {TtyHostPath} {args}",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = false,
                    RedirectStandardOutput = false,
                    RedirectStandardError = false
                };
                Console.WriteLine($"[TtyHostSpawner] Spawning as user: {effectiveRunAsUser}");
            }
            else
            {
                psi = new ProcessStartInfo
                {
                    FileName = TtyHostPath,
                    Arguments = args,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = false,
                    RedirectStandardOutput = false,
                    RedirectStandardError = false
                };
            }

            var process = Process.Start(psi);
            if (process is null)
            {
                Console.WriteLine("[TtyHostSpawner] Process.Start returned null");
                return false;
            }

            processId = process.Id;
            Console.WriteLine($"[TtyHostSpawner] Spawned mthost (PID: {processId})");
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSpawner] Failed to spawn: {ex.Message}");
            return false;
        }
    }
#endif

#if WINDOWS
    [SupportedOSPlatform("windows")]
    private static bool SpawnWindows(string args, out int processId)
    {
        processId = 0;
        var commandLine = $"\"{TtyHostPath}\" {args}";

        if (IsRunningAsSystem())
        {
            return SpawnAsUser(commandLine, out processId);
        }
        else
        {
            return SpawnDirect(commandLine, out processId);
        }
    }

    [SupportedOSPlatform("windows")]
    private static bool SpawnDirect(string commandLine, out int processId)
    {
        processId = 0;

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf<STARTUPINFO>();

        var success = CreateProcess(
            null,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            CREATE_NO_WINDOW,
            IntPtr.Zero,
            null,
            ref si,
            out var pi);

        if (!success)
        {
            Console.WriteLine($"[TtyHostSpawner] CreateProcess failed: {Marshal.GetLastWin32Error()}");
            return false;
        }

        processId = pi.dwProcessId;
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        Console.WriteLine($"[TtyHostSpawner] Spawned mthost (PID: {processId})");
        return true;
    }

    [SupportedOSPlatform("windows")]
    private static bool SpawnAsUser(string commandLine, out int processId)
    {
        processId = 0;

        var sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF)
        {
            Console.WriteLine("[TtyHostSpawner] No active console session");
            return false;
        }

        if (!WTSQueryUserToken(sessionId, out var userToken))
        {
            Console.WriteLine($"[TtyHostSpawner] WTSQueryUserToken failed: {Marshal.GetLastWin32Error()}");
            return false;
        }

        try
        {
            if (!CreateEnvironmentBlock(out var envBlock, userToken, false))
            {
                Console.WriteLine($"[TtyHostSpawner] CreateEnvironmentBlock failed: {Marshal.GetLastWin32Error()}");
                return false;
            }

            try
            {
                var si = new STARTUPINFO();
                si.cb = Marshal.SizeOf<STARTUPINFO>();
                si.lpDesktop = Marshal.StringToHGlobalUni("winsta0\\default");
                si.dwFlags = STARTF_USESHOWWINDOW;
                si.wShowWindow = SW_HIDE;

                try
                {
                    var success = CreateProcessAsUser(
                        userToken,
                        null,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        false,
                        CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                        envBlock,
                        null,
                        ref si,
                        out var pi);

                    if (!success)
                    {
                        Console.WriteLine($"[TtyHostSpawner] CreateProcessAsUser failed: {Marshal.GetLastWin32Error()}");
                        return false;
                    }

                    processId = pi.dwProcessId;
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);

                    Console.WriteLine($"[TtyHostSpawner] Spawned mthost as user (PID: {processId}, Session: {sessionId})");
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

    [SupportedOSPlatform("windows")]
    private static bool IsRunningAsSystem()
    {
        try
        {
            var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            return identity.IsSystem;
        }
        catch
        {
            return false;
        }
    }
#endif

    private static string GetTtyHostPath()
    {
        var currentExe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(currentExe))
        {
            return string.Empty;
        }

        var dir = Path.GetDirectoryName(currentExe);
        if (string.IsNullOrEmpty(dir))
        {
            return string.Empty;
        }

        var exeName = OperatingSystem.IsWindows() ? "mthost.exe" : "mthost";

        // Check same directory first (production/published builds)
        var sameDirPath = Path.Combine(dir, exeName);
        if (File.Exists(sameDirPath))
        {
            return sameDirPath;
        }

        // Development fallback: check sibling TtyHost project's output
        var repoRoot = Path.GetFullPath(Path.Combine(dir, "..", "..", "..", ".."));
#if WINDOWS
        var devPath = Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.TtyHost", "bin", "Debug", "net10.0", "win-x64", exeName);
#else
        var rid = OperatingSystem.IsMacOS() ? "osx-arm64" : "linux-x64";
        var devPath = Path.Combine(repoRoot, "Ai.Tlbx.MidTerm.TtyHost", "bin", "Debug", "net10.0", rid, exeName);
#endif
        if (File.Exists(devPath))
        {
            return devPath;
        }

        return sameDirPath;
    }

#if WINDOWS
    #region P/Invoke

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
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
#endif
}
