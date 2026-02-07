using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Update;
#if WINDOWS
using System.Runtime.Versioning;
#endif

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Spawns mthost processes. Cross-platform with special handling for Windows service mode.
/// </summary>
public static class TtyHostSpawner
{
    private static readonly string TtyHostPath = GetTtyHostPath();
    private static bool _integrityVerified;
    private static readonly object _verifyLock = new();
    private static string? _cachedVersion;
    private static bool _versionChecked;

    /// <summary>
    /// Gets the expected full path to mthost for this mt installation.
    /// Used to filter discovered processes to only those from this installation.
    /// </summary>
    public static string ExpectedTtyHostPath => TtyHostPath;

    public static string? GetTtyHostVersion()
    {
        // Return cached version if already checked (version doesn't change at runtime)
        if (_versionChecked)
        {
            return _cachedVersion;
        }

        if (!File.Exists(TtyHostPath))
        {
            _versionChecked = true;
            return null;
        }

        try
        {
            if (OperatingSystem.IsWindows())
            {
                // Windows: read version from PE file metadata (fast, no process spawn)
                var versionInfo = FileVersionInfo.GetVersionInfo(TtyHostPath);
                _cachedVersion = versionInfo.ProductVersion ?? versionInfo.FileVersion;
            }
            else
            {
                // macOS/Linux: PE metadata not available, run mthost --version once
                // Result is cached to avoid spawning process on every health check
                var psi = new ProcessStartInfo
                {
                    FileName = TtyHostPath,
                    Arguments = "--version",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true
                };

                using var process = Process.Start(psi);
                if (process is not null)
                {
                    var output = process.StandardOutput.ReadToEnd().Trim();
                    process.WaitForExit(5000);

                    // Output is "mthost 6.7.10" - extract just the version
                    if (!string.IsNullOrEmpty(output))
                    {
                        var parts = output.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                        _cachedVersion = parts.Length >= 2 ? parts[1] : output;
                    }
                }
            }
        }
        catch
        {
            // Ignore errors, just return null
        }

        _versionChecked = true;
        return _cachedVersion;
    }

    /// <summary>
    /// Verifies mthost binary integrity against version.json checksums.
    /// Result is cached after first successful verification.
    /// </summary>
    private static bool VerifyMthostIntegrity()
    {
        // Fast path: already verified this session
        if (_integrityVerified)
        {
            return true;
        }

        lock (_verifyLock)
        {
            if (_integrityVerified)
            {
                return true;
            }

            var installDir = Path.GetDirectoryName(TtyHostPath);
            if (string.IsNullOrEmpty(installDir))
            {
                return true; // Can't verify, allow (dev mode)
            }

            var versionJsonPath = Path.Combine(installDir, "version.json");
            if (!File.Exists(versionJsonPath))
            {
                // No version.json = dev mode or unsigned install, allow
                _integrityVerified = true;
                return true;
            }

            try
            {
                var json = File.ReadAllText(versionJsonPath);
                var manifest = JsonSerializer.Deserialize<VersionManifest>(json, VersionManifestContext.Default.VersionManifest);

                if (manifest?.Checksums is null || manifest.Checksums.Count == 0)
                {
                    // Unsigned release, allow
                    _integrityVerified = true;
                    return true;
                }

                var mthostName = OperatingSystem.IsWindows() ? "mthost.exe" : "mthost";
                if (!manifest.Checksums.TryGetValue(mthostName, out var expectedHash))
                {
                    // mthost not in checksums (shouldn't happen), allow but warn
                    Log.Warn(() => "TtyHostSpawner: mthost not in version.json checksums");
                    _integrityVerified = true;
                    return true;
                }

                // Compute actual hash
                using var stream = File.OpenRead(TtyHostPath);
                var actualHash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();

                if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
                {
                    Log.Error(() => $"TtyHostSpawner: mthost checksum mismatch! Expected: {expectedHash}, Actual: {actualHash}");
                    return false;
                }

                Log.Info(() => "TtyHostSpawner: mthost integrity verified");
                _integrityVerified = true;
                return true;
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"TtyHostSpawner: Could not verify mthost integrity: {ex.Message}");
                // On error, allow but don't cache
                return true;
            }
        }
    }

    public static bool SpawnTtyHost(
        string sessionId,
        string? shellType,
        string? workingDirectory,
        int cols,
        int rows,
        string? runAsUser,
        out int processId)
    {
        processId = 0;

        if (!File.Exists(TtyHostPath))
        {
            Log.Error(() => $"TtyHostSpawner: mthost not found at: {TtyHostPath}");
            return false;
        }

        if (!VerifyMthostIntegrity())
        {
            Log.Error(() => "TtyHostSpawner: mthost integrity check failed - refusing to spawn");
            return false;
        }

        var args = BuildArgs(sessionId, shellType, workingDirectory, cols, rows);

#pragma warning disable CA1416 // Validate platform compatibility (compile-time guard via WINDOWS constant)
#if WINDOWS
        return SpawnWindows(args, runAsUser, out processId);
#else
        return SpawnUnix(args, runAsUser, out processId);
#endif
#pragma warning restore CA1416
    }

    private static string BuildArgs(string sessionId, string? shellType, string? workingDirectory, int cols, int rows)
    {
        var args = $"--session {sessionId} --cols {cols} --rows {rows}";
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
    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern uint geteuid();

    private static bool SpawnUnix(string args, string? runAsUser, out int processId)
    {
        processId = 0;

        try
        {
            ProcessStartInfo psi;

            // If running as root and runAsUser is configured, use sudo -u to drop privileges
            var isRoot = geteuid() == 0;

            if (isRoot && !string.IsNullOrEmpty(runAsUser))
            {
                // SECURITY: Defensive re-validation before sudo command
                if (!UserValidationService.IsValidUsernameFormat(runAsUser))
                {
                    Log.Error(() => $"TtyHostSpawner SECURITY: Rejected invalid username format: {runAsUser}");
                    return false;
                }

                psi = new ProcessStartInfo
                {
                    FileName = "sudo",
                    Arguments = $"-H -u {runAsUser} {TtyHostPath} {args}",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = false,
                    RedirectStandardOutput = false,
                    RedirectStandardError = false
                };
                Log.Info(() => $"TtyHostSpawner: Spawning as user: {runAsUser}");
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
                Log.Error(() => "TtyHostSpawner: Process.Start returned null");
                return false;
            }

            processId = process.Id;
            if (isRoot && !string.IsNullOrEmpty(runAsUser))
            {
                Log.Info(() => $"TtyHostSpawner: Spawned via sudo (PID: {process.Id} is sudo, not mthost). Socket discovery will use glob pattern.");
            }
            else
            {
                Log.Info(() => $"TtyHostSpawner: Spawned mthost (PID: {process.Id})");
            }
            return true;
        }
        catch (Exception ex)
        {
            Log.Error(() => $"TtyHostSpawner: Failed to spawn: {ex.Message}");
            return false;
        }
    }
#endif

#if WINDOWS
    [SupportedOSPlatform("windows")]
    private static bool SpawnWindows(string args, string? runAsUser, out int processId)
    {
        processId = 0;
        var commandLine = $"\"{TtyHostPath}\" {args}";

        if (IsRunningAsSystem())
        {
            return SpawnAsUser(commandLine, runAsUser, out processId);
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
            Log.Error(() => $"TtyHostSpawner: CreateProcess failed: {Marshal.GetLastWin32Error()}");
            return false;
        }

        processId = pi.dwProcessId;
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        var pid = processId;
        Log.Info(() => $"TtyHostSpawner: Spawned mthost (PID: {pid})");
        return true;
    }

    [SupportedOSPlatform("windows")]
    private static bool SpawnAsUser(string commandLine, string? runAsUser, out int processId)
    {
        processId = 0;

        if (!TryGetUserToken(runAsUser, out var userToken, out var sessionId))
        {
            return false;
        }

        try
        {
            if (!CreateEnvironmentBlock(out var envBlock, userToken, false))
            {
                Log.Error(() => $"TtyHostSpawner: CreateEnvironmentBlock failed: {Marshal.GetLastWin32Error()}");
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
                        Log.Error(() => $"TtyHostSpawner: CreateProcessAsUser failed: {Marshal.GetLastWin32Error()}");
                        return false;
                    }

                    processId = pi.dwProcessId;
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);

                    var pid = processId;
                    var sess = sessionId;
                    Log.Info(() => $"TtyHostSpawner: Spawned mthost as user (PID: {pid}, Session: {sess})");
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

    [SupportedOSPlatform("windows")]
    private static bool TryGetUserToken(string? runAsUser, out IntPtr userToken, out uint sessionId)
    {
        userToken = IntPtr.Zero;
        sessionId = 0;

        var hasTargetUser = !string.IsNullOrEmpty(runAsUser);

        // Fast path when no specific user requested: try active console session
        if (!hasTargetUser)
        {
            var consoleSession = WTSGetActiveConsoleSessionId();
            if (consoleSession != 0xFFFFFFFF && WTSQueryUserToken(consoleSession, out userToken))
            {
                sessionId = consoleSession;
                Log.Info(() => $"TtyHostSpawner: Got user token from console session {consoleSession}");
                return true;
            }
        }

        // Enumerate all sessions to find the right user (or any user as fallback)
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var pSessionInfo, out var sessionCount))
        {
            Log.Error(() => $"TtyHostSpawner: WTSEnumerateSessions failed: {Marshal.GetLastWin32Error()}");
            return false;
        }

        try
        {
            var sessionInfoSize = Marshal.SizeOf<WTS_SESSION_INFO>();
            IntPtr fallbackToken = IntPtr.Zero;
            uint fallbackSessionId = 0;

            for (var i = 0; i < sessionCount; i++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(pSessionInfo + i * sessionInfoSize);

                if (info.State is not (WTS_CONNECTSTATE_CLASS.WTSActive or WTS_CONNECTSTATE_CLASS.WTSDisconnected))
                {
                    continue;
                }

                if (hasTargetUser)
                {
                    var sessionUser = GetSessionUsername(info.SessionId);
                    if (sessionUser is null)
                    {
                        continue;
                    }

                    if (string.Equals(sessionUser, runAsUser, StringComparison.OrdinalIgnoreCase))
                    {
                        if (WTSQueryUserToken(info.SessionId, out userToken))
                        {
                            sessionId = info.SessionId;
                            Log.Info(() => $"TtyHostSpawner: Got token for user '{runAsUser}' from session {info.SessionId}");
                            // Clean up any fallback token we acquired
                            if (fallbackToken != IntPtr.Zero)
                            {
                                CloseHandle(fallbackToken);
                            }
                            return true;
                        }
                    }
                    else if (fallbackToken == IntPtr.Zero)
                    {
                        // Keep first available token as fallback
                        if (WTSQueryUserToken(info.SessionId, out fallbackToken))
                        {
                            fallbackSessionId = info.SessionId;
                        }
                    }
                }
                else
                {
                    if (WTSQueryUserToken(info.SessionId, out userToken))
                    {
                        sessionId = info.SessionId;
                        Log.Info(() => $"TtyHostSpawner: Got user token from session {info.SessionId} (state: {info.State})");
                        return true;
                    }
                }
            }

            // Clean up fallback token if we didn't use it
            if (fallbackToken != IntPtr.Zero)
            {
                CloseHandle(fallbackToken);
            }

            if (hasTargetUser)
            {
                Log.Error(() => $"TtyHostSpawner: User '{runAsUser}' has no active session — refusing to spawn as different user");
                return false;
            }
        }
        finally
        {
            WTSFreeMemory(pSessionInfo);
        }

        Log.Error(() => "TtyHostSpawner: No session with accessible user token found");
        return false;
    }

    [SupportedOSPlatform("windows")]
    private static string? GetSessionUsername(uint sessionId)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WTS_INFO_CLASS.WTSUserName, out var buffer, out var bytesReturned))
        {
            return null;
        }

        try
        {
            if (bytesReturned <= 2)
            {
                return null;
            }
            return Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            WTSFreeMemory(buffer);
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

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessions(
        IntPtr hServer,
        uint reserved,
        uint version,
        out IntPtr ppSessionInfo,
        out int pCount);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformation(
        IntPtr hServer,
        uint sessionId,
        WTS_INFO_CLASS wtsInfoClass,
        out IntPtr ppBuffer,
        out int pBytesReturned);

    private enum WTS_INFO_CLASS
    {
        WTSUserName = 5
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO
    {
        public uint SessionId;
        public IntPtr pWinStationName;
        public WTS_CONNECTSTATE_CLASS State;
    }

    private enum WTS_CONNECTSTATE_CLASS
    {
        WTSActive,
        WTSConnected,
        WTSConnectQuery,
        WTSShadow,
        WTSDisconnected,
        WTSIdle,
        WTSListen,
        WTSReset,
        WTSDown,
        WTSInit
    }

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
