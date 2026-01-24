#if WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Windows system tray icon service. Has two modes:
/// - Direct mode: Runs in main process for user-mode installations
/// - Helper manager mode: Spawns tray helpers in user sessions for service-mode installations
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SystemTrayService : IDisposable
{
    private const uint WM_TRAYICON = 0x8000; // WM_APP
    private const uint WM_COMMAND = 0x0111;
    private const uint WM_DESTROY = 0x0002;
    private const uint WM_NULL = 0x0000;
    private const uint WM_RBUTTONUP = 0x0205;
    private const uint WM_LBUTTONUP = 0x0202;

    private const uint IDM_UPTIME = 1000;
    private const uint IDM_NETWORK_SUBMENU = 1100;
    private const uint IDM_TRUST_CERTS = 1200;
    private const uint IDM_VERSION = 1300;
    private const uint IDM_CHECK_UPDATE = 1400;
    private const uint IDM_CLOSE_SESSIONS = 1500;
    private const uint IDM_CLOSE = 1600;

    private const uint MF_STRING = 0x0000;
    private const uint MF_GRAYED = 0x0001;
    private const uint MF_SEPARATOR = 0x0800;
    private const uint MF_POPUP = 0x0010;

    private const uint TPM_RIGHTALIGN = 0x0008;
    private const uint TPM_BOTTOMALIGN = 0x0020;

    private const uint NIM_ADD = 0x0000;
    private const uint NIM_MODIFY = 0x0001;
    private const uint NIM_DELETE = 0x0002;

    private const uint NIF_MESSAGE = 0x0001;
    private const uint NIF_ICON = 0x0002;
    private const uint NIF_TIP = 0x0004;
    private const uint NIF_INFO = 0x0010;

    private const uint NIIF_INFO = 0x0001;

    private const uint MB_YESNO = 0x0004;
    private const uint MB_ICONWARNING = 0x0030;
    private const uint MB_ICONQUESTION = 0x0020;
    private const int IDYES = 6;

    private readonly TtyHostSessionManager _sessionManager;
    private readonly UpdateService _updateService;
    private readonly CertificateInfoService _certInfoService;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly SettingsService _settingsService;
    private readonly int _port;
    private readonly bool _isServiceMode;
    private readonly string _version;

    private Thread? _messageThread;
    private IntPtr _hwnd;
    private IntPtr _icon;
    private bool _disposed;
    private bool _updateAvailable;
    private string? _latestVersion;
    private WndProcDelegate? _wndProcDelegate;

    // Cached data for instant menu display
    private List<(string Name, string Ip)> _cachedNetworks = [];
    private Timer? _networkRefreshTimer;

    // For service mode: track spawned tray helpers per session
    private readonly Dictionary<uint, int> _helperProcesses = new();
    private readonly object _helperLock = new();
    private Timer? _sessionMonitorTimer;

    private delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    public SystemTrayService(
        TtyHostSessionManager sessionManager,
        UpdateService updateService,
        CertificateInfoService certInfoService,
        IHostApplicationLifetime lifetime,
        SettingsService settingsService,
        int port,
        string version)
    {
        _sessionManager = sessionManager;
        _updateService = updateService;
        _certInfoService = certInfoService;
        _lifetime = lifetime;
        _settingsService = settingsService;
        _port = port;
        _version = version;
        _isServiceMode = settingsService.IsRunningAsService;
    }

    public void Start()
    {
        if (_isServiceMode)
        {
            StartHelperManager();
        }
        else
        {
            StartDirectMode();
        }
    }

    private void StartDirectMode()
    {
        // Cache network interfaces at startup
        _cachedNetworks = GetNetworkInterfaces();

        // Refresh networks in background every 30 seconds
        _networkRefreshTimer = new Timer(_ =>
        {
            try
            {
                _cachedNetworks = GetNetworkInterfaces();
            }
            catch
            {
            }
        }, null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));

        _messageThread = new Thread(MessageLoop)
        {
            Name = "SystemTrayMessageLoop",
            IsBackground = true
        };
        _messageThread.SetApartmentState(ApartmentState.STA);
        _messageThread.Start();
    }

    private void MessageLoop()
    {
        try
        {
            var className = $"MidTermTray_{Environment.ProcessId}";
            _wndProcDelegate = WndProc;

            var wndClass = new WNDCLASSEX
            {
                cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
                lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProcDelegate),
                hInstance = GetModuleHandle(null),
                lpszClassName = className
            };

            var atom = RegisterClassEx(ref wndClass);
            if (atom == 0)
            {
                Log.Error(() => $"SystemTray: RegisterClassEx failed: {Marshal.GetLastWin32Error()}");
                return;
            }

            _hwnd = CreateWindowEx(0, className, "MidTerm Tray", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wndClass.hInstance, IntPtr.Zero);
            if (_hwnd == IntPtr.Zero)
            {
                Log.Error(() => $"SystemTray: CreateWindowEx failed: {Marshal.GetLastWin32Error()}");
                return;
            }

            _icon = LoadTrayIcon();
            AddTrayIcon();

            Log.Info(() => "SystemTray: Tray icon added successfully");

            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }
        catch (Exception ex)
        {
            Log.Exception(ex, "SystemTray.MessageLoop");
        }
    }

    private IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        switch (msg)
        {
            case WM_TRAYICON:
                var mouseMsg = (uint)(lParam.ToInt64() & 0xFFFF);
                if (mouseMsg == WM_RBUTTONUP || mouseMsg == WM_LBUTTONUP)
                {
                    // Capture cursor position IMMEDIATELY before any other work
                    GetCursorPos(out var clickPos);
                    ShowContextMenu(clickPos);
                }
                return IntPtr.Zero;

            case WM_COMMAND:
                var menuId = (uint)(wParam.ToInt64() & 0xFFFF);
                HandleMenuCommand(menuId);
                return IntPtr.Zero;

            case WM_DESTROY:
                RemoveTrayIcon();
                PostQuitMessage(0);
                return IntPtr.Zero;
        }

        return DefWindowProc(hwnd, msg, wParam, lParam);
    }

    private IntPtr LoadTrayIcon()
    {
        try
        {
            var exePath = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath))
            {
                return IntPtr.Zero;
            }

            var largeIcon = IntPtr.Zero;
            var smallIcon = IntPtr.Zero;
            var count = ExtractIconEx(exePath, 0, ref largeIcon, ref smallIcon, 1);

            if (count > 0 && smallIcon != IntPtr.Zero)
            {
                if (largeIcon != IntPtr.Zero)
                {
                    DestroyIcon(largeIcon);
                }
                return smallIcon;
            }

            if (largeIcon != IntPtr.Zero)
            {
                return largeIcon;
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"SystemTray: Failed to load icon: {ex.Message}");
        }

        return IntPtr.Zero;
    }

    private void AddTrayIcon()
    {
        var nid = new NOTIFYICONDATA
        {
            cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(),
            hWnd = _hwnd,
            uID = 1,
            uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage = WM_TRAYICON,
            hIcon = _icon,
            szTip = "MidTerm Terminal"
        };

        Shell_NotifyIcon(NIM_ADD, ref nid);
    }

    private void RemoveTrayIcon()
    {
        var nid = new NOTIFYICONDATA
        {
            cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(),
            hWnd = _hwnd,
            uID = 1
        };

        Shell_NotifyIcon(NIM_DELETE, ref nid);

        if (_icon != IntPtr.Zero)
        {
            DestroyIcon(_icon);
            _icon = IntPtr.Zero;
        }
    }

    private void ShowContextMenu(POINT clickPos)
    {
        var hMenu = CreatePopupMenu();
        if (hMenu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            // All data here is already in memory - no slow operations
            var uptime = DateTime.UtcNow - Process.GetCurrentProcess().StartTime.ToUniversalTime();
            var uptimeStr = FormatUptime(uptime);
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, IDM_UPTIME, $"Runs since: {uptimeStr}");

            var networkMenu = CreateNetworkSubmenu();
            if (networkMenu != IntPtr.Zero)
            {
                AppendMenu(hMenu, MF_POPUP, (uint)networkMenu.ToInt64(), "Network Interfaces");
            }

            AppendMenu(hMenu, MF_SEPARATOR, 0, null);

            AppendMenu(hMenu, MF_STRING, IDM_TRUST_CERTS, "Trust my Certs");

            AppendMenu(hMenu, MF_SEPARATOR, 0, null);

            AppendMenu(hMenu, MF_STRING | MF_GRAYED, IDM_VERSION, $"Version {_version}");

            if (_updateAvailable && !string.IsNullOrEmpty(_latestVersion))
            {
                AppendMenu(hMenu, MF_STRING, IDM_CHECK_UPDATE, $"Install update ({_latestVersion})");
            }
            else
            {
                AppendMenu(hMenu, MF_STRING, IDM_CHECK_UPDATE, "Check for update");
            }

            AppendMenu(hMenu, MF_SEPARATOR, 0, null);

            var sessionCount = _sessionManager.GetAllSessions().Count;
            var closeSessionsText = sessionCount > 0 ? $"Close all sessions ({sessionCount})" : "Close all sessions";
            AppendMenu(hMenu, sessionCount > 0 ? MF_STRING : (MF_STRING | MF_GRAYED), IDM_CLOSE_SESSIONS, closeSessionsText);

            AppendMenu(hMenu, MF_STRING, IDM_CLOSE, "Close");

            SetForegroundWindow(_hwnd);

            // Use position captured at click time, not current cursor position
            TrackPopupMenuEx(hMenu, TPM_RIGHTALIGN | TPM_BOTTOMALIGN, clickPos.X, clickPos.Y, _hwnd, IntPtr.Zero);

            PostMessage(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
        }
        finally
        {
            DestroyMenu(hMenu);
        }
    }

    private IntPtr CreateNetworkSubmenu()
    {
        var hMenu = CreatePopupMenu();
        if (hMenu == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }

        // Use cached networks - refreshed in background, not here
        uint id = IDM_NETWORK_SUBMENU + 1;

        foreach (var (name, ip) in _cachedNetworks)
        {
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, id++, $"{name}: {ip}");
        }

        if (_cachedNetworks.Count == 0)
        {
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, id, "(No network interfaces)");
        }

        return hMenu;
    }

    private static List<(string Name, string Ip)> GetNetworkInterfaces()
    {
        var result = new List<(string, string)>();

        foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up)
            {
                continue;
            }

            if (ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback)
            {
                continue;
            }

            if (ni.Name.Contains("VMware", StringComparison.OrdinalIgnoreCase) ||
                ni.Name.StartsWith("vEthernet", StringComparison.OrdinalIgnoreCase) ||
                ni.Name.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) ||
                ni.Name.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            foreach (var addr in ni.GetIPProperties().UnicastAddresses)
            {
                if (addr.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    result.Add((ni.Name, addr.Address.ToString()));
                }
            }
        }

        return result;
    }

    private static string FormatUptime(TimeSpan uptime)
    {
        if (uptime.TotalDays >= 1)
        {
            return $"{(int)uptime.TotalDays}d {uptime.Hours}h";
        }
        if (uptime.TotalHours >= 1)
        {
            return $"{(int)uptime.TotalHours}h {uptime.Minutes}m";
        }
        return $"{uptime.Minutes}m";
    }

    private void HandleMenuCommand(uint menuId)
    {
        switch (menuId)
        {
            case IDM_TRUST_CERTS:
                TrustCertificate();
                break;

            case IDM_CHECK_UPDATE:
                if (_updateAvailable)
                {
                    ApplyUpdate();
                }
                else
                {
                    CheckForUpdate();
                }
                break;

            case IDM_CLOSE_SESSIONS:
                CloseAllSessions();
                break;

            case IDM_CLOSE:
                CloseApplication();
                break;
        }
    }

    private void TrustCertificate()
    {
        try
        {
            var pemBytes = _certInfoService.ExportPemBytes();
            if (pemBytes is null)
            {
                ShowBalloon("Certificate Error", "No certificate available to trust.");
                return;
            }

            var tempPath = Path.Combine(Path.GetTempPath(), $"midterm-cert-{Guid.NewGuid():N}.pem");
            File.WriteAllBytes(tempPath, pemBytes);

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "certutil",
                    Arguments = $"-addstore Root \"{tempPath}\"",
                    UseShellExecute = true,
                    Verb = "runas",
                    CreateNoWindow = true
                };

                var process = Process.Start(psi);
                if (process is not null)
                {
                    process.WaitForExit(30000);
                    if (process.ExitCode == 0)
                    {
                        ShowBalloon("Certificate Trusted", "MidTerm certificate added to trusted root store.");
                    }
                    else
                    {
                        ShowBalloon("Certificate Error", $"certutil exited with code {process.ExitCode}");
                    }
                }
            }
            finally
            {
                try { File.Delete(tempPath); } catch { }
            }
        }
        catch (Exception ex)
        {
            Log.Exception(ex, "SystemTray.TrustCertificate");
            ShowBalloon("Certificate Error", ex.Message);
        }
    }

    private void CheckForUpdate()
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                ShowBalloon("Checking for updates...", "Please wait.");

                var update = _updateService.CheckForUpdateAsync().GetAwaiter().GetResult();

                if (update is not null && update.Available)
                {
                    _updateAvailable = true;
                    _latestVersion = update.LatestVersion;
                    ShowBalloon("Update Available", $"Version {update.LatestVersion} is available. Right-click to install.");
                }
                else
                {
                    ShowBalloon("Up to Date", $"You are running the latest version ({_version}).");
                }
            }
            catch (Exception ex)
            {
                Log.Exception(ex, "SystemTray.CheckForUpdate");
                ShowBalloon("Update Check Failed", ex.Message);
            }
        });
    }

    private void ApplyUpdate()
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                ShowBalloon("Downloading Update...", "Please wait. MidTerm will restart automatically.");

                var extractedDir = _updateService.DownloadUpdateAsync().GetAwaiter().GetResult();

                if (string.IsNullOrEmpty(extractedDir))
                {
                    ShowBalloon("Update Failed", "Failed to download update.");
                    return;
                }

                var update = _updateService.LatestUpdate;
                var scriptPath = UpdateScriptGenerator.GenerateUpdateScript(
                    extractedDir,
                    UpdateService.GetCurrentBinaryPath(),
                    _settingsService.SettingsDirectory,
                    update?.Type ?? Models.Update.UpdateType.Full);

                Thread.Sleep(2000);
                UpdateScriptGenerator.ExecuteUpdateScript(scriptPath);
                Environment.Exit(0);
            }
            catch (Exception ex)
            {
                Log.Exception(ex, "SystemTray.ApplyUpdate");
                ShowBalloon("Update Failed", ex.Message);
            }
        });
    }

    private void CloseAllSessions()
    {
        var sessions = _sessionManager.GetAllSessions();
        if (sessions.Count == 0)
        {
            return;
        }

        var result = MessageBox(_hwnd,
            $"Close all {sessions.Count} terminal session(s)?\n\nThis will terminate any running processes.",
            "Confirm Close Sessions",
            MB_YESNO | MB_ICONWARNING);

        if (result == IDYES)
        {
            foreach (var session in sessions)
            {
                try
                {
                    _sessionManager.CloseSessionAsync(session.Id).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    Log.Warn(() => $"SystemTray: Failed to close session {session.Id}: {ex.Message}");
                }
            }

            ShowBalloon("Sessions Closed", $"Closed {sessions.Count} session(s).");
        }
    }

    private void CloseApplication()
    {
        var sessions = _sessionManager.GetAllSessions();
        var message = sessions.Count > 0
            ? $"Close MidTerm?\n\nThis will also close {sessions.Count} active terminal session(s)."
            : "Close MidTerm?";

        var result = MessageBox(_hwnd, message, "Confirm Close", MB_YESNO | MB_ICONQUESTION);

        if (result == IDYES)
        {
            _lifetime.StopApplication();
        }
    }

    private void ShowBalloon(string title, string message)
    {
        var nid = new NOTIFYICONDATA
        {
            cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(),
            hWnd = _hwnd,
            uID = 1,
            uFlags = NIF_INFO,
            dwInfoFlags = NIIF_INFO,
            szInfoTitle = title.Length > 63 ? title[..63] : title,
            szInfo = message.Length > 255 ? message[..255] : message
        };

        Shell_NotifyIcon(NIM_MODIFY, ref nid);
    }

    #region Service Mode - Helper Manager

    private void StartHelperManager()
    {
        Log.Info(() => "SystemTray: Starting in helper manager mode (service)");
        SpawnHelpersForActiveSessions();

        // Monitor for new user sessions (e.g., user logs in after service starts)
        _sessionMonitorTimer = new Timer(_ =>
        {
            try
            {
                SpawnHelpersForActiveSessions();
                CleanupDeadHelpers();
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"SystemTray: Session monitor error: {ex.Message}");
            }
        }, null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10));
    }

    private void CleanupDeadHelpers()
    {
        lock (_helperLock)
        {
            var deadSessions = new List<uint>();
            foreach (var (sessionId, pid) in _helperProcesses)
            {
                try
                {
                    var process = Process.GetProcessById(pid);
                    if (process.HasExited)
                    {
                        deadSessions.Add(sessionId);
                    }
                }
                catch
                {
                    deadSessions.Add(sessionId);
                }
            }

            foreach (var sessionId in deadSessions)
            {
                _helperProcesses.Remove(sessionId);
            }
        }
    }

    private void SpawnHelpersForActiveSessions()
    {
        if (!TryGetActiveSessions(out var sessions))
        {
            return;
        }

        foreach (var sessionId in sessions)
        {
            SpawnTrayHelper(sessionId);
        }
    }

    private bool TryGetActiveSessions(out List<uint> sessions)
    {
        sessions = [];

        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var pSessionInfo, out var count))
        {
            return false;
        }

        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (int i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(pSessionInfo + i * size);
                if (info.State == WTS_CONNECTSTATE_CLASS.WTSActive ||
                    info.State == WTS_CONNECTSTATE_CLASS.WTSDisconnected)
                {
                    sessions.Add(info.SessionId);
                }
            }
        }
        finally
        {
            WTSFreeMemory(pSessionInfo);
        }

        return true;
    }

    private void SpawnTrayHelper(uint sessionId)
    {
        lock (_helperLock)
        {
            if (_helperProcesses.ContainsKey(sessionId))
            {
                return;
            }

            var exePath = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exePath))
            {
                return;
            }

            var commandLine = $"\"{exePath}\" --tray-helper --port {_port}";

            if (!WTSQueryUserToken(sessionId, out var userToken))
            {
                return;
            }

            try
            {
                if (!CreateEnvironmentBlock(out var envBlock, userToken, false))
                {
                    Log.Warn(() => $"SystemTray: CreateEnvironmentBlock failed for session {sessionId}");
                    return;
                }

                try
                {
                    var si = new STARTUPINFO
                    {
                        cb = Marshal.SizeOf<STARTUPINFO>(),
                        lpDesktop = "winsta0\\default",
                        dwFlags = STARTF_USESHOWWINDOW,
                        wShowWindow = SW_HIDE
                    };

                    if (CreateProcessAsUser(
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
                        out var pi))
                    {
                        _helperProcesses[sessionId] = pi.dwProcessId;
                        CloseHandle(pi.hThread);
                        CloseHandle(pi.hProcess);

                        Log.Info(() => $"SystemTray: Spawned tray helper for session {sessionId} (PID: {pi.dwProcessId})");
                    }
                    else
                    {
                        Log.Warn(() => $"SystemTray: CreateProcessAsUser failed for session {sessionId}: {Marshal.GetLastWin32Error()}");
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
    }

    #endregion

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;

        _networkRefreshTimer?.Dispose();
        _sessionMonitorTimer?.Dispose();

        lock (_helperLock)
        {
            foreach (var (_, pid) in _helperProcesses)
            {
                try
                {
                    var process = Process.GetProcessById(pid);
                    process.Kill();
                }
                catch
                {
                }
            }
            _helperProcesses.Clear();
        }

        if (_hwnd != IntPtr.Zero)
        {
            PostMessage(_hwnd, WM_DESTROY, IntPtr.Zero, IntPtr.Zero);
        }
    }

    #region P/Invoke

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public uint cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATA
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;
        public uint dwInfoFlags;
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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
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

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint dwExStyle, string lpClassName, string lpWindowName, uint dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr hWnd, uint uMsg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int nExitCode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool AppendMenu(IntPtr hMenu, uint uFlags, uint uIDNewItem, string? lpNewItem);

    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(IntPtr hMenu);

    [DllImport("user32.dll")]
    private static extern bool TrackPopupMenuEx(IntPtr hMenu, uint uFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string lpText, string lpCaption, uint uType);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint ExtractIconEx(string lpszFile, int nIconIndex, ref IntPtr phiconLarge, ref IntPtr phiconSmall, uint nIcons);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessions(IntPtr hServer, uint reserved, uint version, out IntPtr ppSessionInfo, out int pCount);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr hToken, string? lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    #endregion
}
#endif
