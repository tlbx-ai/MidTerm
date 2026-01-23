#if WINDOWS
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Standalone tray helper process for service mode.
/// Runs in user session and communicates with MidTerm service via localhost API.
/// </summary>
[SupportedOSPlatform("windows")]
public static class TrayHelperService
{
    private const uint WM_TRAYICON = 0x8000;
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

    private static int _port;
    private static IntPtr _hwnd;
    private static IntPtr _icon;
    private static HttpClient? _httpClient;
    private static string? _version;
    private static long _serverUptimeAtRefresh;
    private static DateTime _lastRefreshTime;
    private static bool _updateAvailable;
    private static string? _latestVersion;
    private static List<SessionInfoDto>? _sessions;
    private static List<NetworkInterfaceDto>? _networks;
    private static WndProcDelegate? _wndProcDelegate;
    private static Timer? _refreshTimer;

    private delegate IntPtr WndProcDelegate(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    public static int Run(int port)
    {
        _port = port;
        _lastRefreshTime = DateTime.UtcNow;

        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = (_, _, _, _) => true
        };
        _httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri($"https://localhost:{port}/"),
            Timeout = TimeSpan.FromSeconds(5)
        };

        // Initial data fetch (non-blocking if it fails)
        RefreshDataFromApi();

        // Background refresh every 10 seconds
        _refreshTimer = new Timer(_ =>
        {
            try { RefreshDataFromApi(); } catch { }
        }, null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));

        try
        {
            RunMessageLoop();
            return 0;
        }
        finally
        {
            _refreshTimer?.Dispose();
            _httpClient.Dispose();
        }
    }

    private static void RunMessageLoop()
    {
        var className = $"MidTermTrayHelper_{Environment.ProcessId}";
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
            return;
        }

        _hwnd = CreateWindowEx(0, className, "MidTerm Tray Helper", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, wndClass.hInstance, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero)
        {
            return;
        }

        _icon = LoadTrayIcon();
        AddTrayIcon();

        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }

    private static IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
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

    private static IntPtr LoadTrayIcon()
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
        catch
        {
        }

        return IntPtr.Zero;
    }

    private static void AddTrayIcon()
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

    private static void RemoveTrayIcon()
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

    private static void ShowContextMenu(POINT clickPos)
    {
        // Use cached data - refreshed in background, not here
        var hMenu = CreatePopupMenu();
        if (hMenu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            // Calculate current uptime from cached server uptime + elapsed since last refresh
            var elapsedSinceRefresh = (long)(DateTime.UtcNow - _lastRefreshTime).TotalSeconds;
            var currentUptime = TimeSpan.FromSeconds(_serverUptimeAtRefresh + elapsedSinceRefresh);
            var uptimeStr = FormatUptime(currentUptime);
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, IDM_UPTIME, $"Runs since: {uptimeStr}");

            var networkMenu = CreateNetworkSubmenu();
            if (networkMenu != IntPtr.Zero)
            {
                AppendMenu(hMenu, MF_POPUP, (uint)networkMenu.ToInt64(), "Network Interfaces");
            }

            AppendMenu(hMenu, MF_SEPARATOR, 0, null);

            AppendMenu(hMenu, MF_STRING, IDM_TRUST_CERTS, "Trust my Certs");

            AppendMenu(hMenu, MF_SEPARATOR, 0, null);

            var versionText = !string.IsNullOrEmpty(_version) ? $"Version {_version}" : "Version unknown";
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, IDM_VERSION, versionText);

            if (_updateAvailable && !string.IsNullOrEmpty(_latestVersion))
            {
                AppendMenu(hMenu, MF_STRING, IDM_CHECK_UPDATE, $"Install update ({_latestVersion})");
            }
            else
            {
                AppendMenu(hMenu, MF_STRING, IDM_CHECK_UPDATE, "Check for update");
            }

            AppendMenu(hMenu, MF_SEPARATOR, 0, null);

            var sessionCount = _sessions?.Count ?? 0;
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

    private static void RefreshDataFromApi()
    {
        try
        {
            var bootstrapJson = _httpClient!.GetStringAsync("api/bootstrap").GetAwaiter().GetResult();
            using var doc = JsonDocument.Parse(bootstrapJson);

            if (doc.RootElement.TryGetProperty("version", out var versionProp))
            {
                _version = versionProp.GetString();
            }

            if (doc.RootElement.TryGetProperty("uptimeSeconds", out var uptimeProp))
            {
                _serverUptimeAtRefresh = uptimeProp.GetInt64();
                _lastRefreshTime = DateTime.UtcNow;
            }

            if (doc.RootElement.TryGetProperty("networks", out var networksProp))
            {
                var networks = new List<NetworkInterfaceDto>();
                foreach (var net in networksProp.EnumerateArray())
                {
                    networks.Add(new NetworkInterfaceDto
                    {
                        Name = net.GetProperty("name").GetString() ?? "",
                        Ip = net.GetProperty("ip").GetString() ?? ""
                    });
                }
                _networks = networks;
            }

            var sessionsJson = _httpClient.GetStringAsync("api/sessions").GetAwaiter().GetResult();
            using var sessionsDoc = JsonDocument.Parse(sessionsJson);

            if (sessionsDoc.RootElement.TryGetProperty("sessions", out var sessionsProp))
            {
                var sessions = new List<SessionInfoDto>();
                foreach (var sess in sessionsProp.EnumerateArray())
                {
                    sessions.Add(new SessionInfoDto
                    {
                        Id = sess.GetProperty("id").GetString() ?? ""
                    });
                }
                _sessions = sessions;
            }
        }
        catch
        {
        }
    }

    private static IntPtr CreateNetworkSubmenu()
    {
        var hMenu = CreatePopupMenu();
        if (hMenu == IntPtr.Zero)
        {
            return IntPtr.Zero;
        }

        uint id = IDM_NETWORK_SUBMENU + 1;

        if (_networks is not null && _networks.Count > 0)
        {
            foreach (var network in _networks)
            {
                AppendMenu(hMenu, MF_STRING | MF_GRAYED, id++, $"{network.Name}: {network.Ip}");
            }
        }
        else
        {
            AppendMenu(hMenu, MF_STRING | MF_GRAYED, id, "(No network interfaces)");
        }

        return hMenu;
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

    private static void HandleMenuCommand(uint menuId)
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

    private static void TrustCertificate()
    {
        try
        {
            var pemBytes = _httpClient!.GetByteArrayAsync("api/certificate/download/pem").GetAwaiter().GetResult();

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
            ShowBalloon("Certificate Error", ex.Message);
        }
    }

    private static void CheckForUpdate()
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                ShowBalloon("Checking for updates...", "Please wait.");

                var updateJson = _httpClient!.GetStringAsync("api/update/check").GetAwaiter().GetResult();
                using var doc = JsonDocument.Parse(updateJson);

                var available = doc.RootElement.TryGetProperty("available", out var availableProp) && availableProp.GetBoolean();

                if (available)
                {
                    _updateAvailable = true;
                    if (doc.RootElement.TryGetProperty("latestVersion", out var latestProp))
                    {
                        _latestVersion = latestProp.GetString();
                    }
                    ShowBalloon("Update Available", $"Version {_latestVersion} is available. Right-click to install.");
                }
                else
                {
                    ShowBalloon("Up to Date", "You are running the latest version.");
                }
            }
            catch (Exception ex)
            {
                ShowBalloon("Update Check Failed", ex.Message);
            }
        });
    }

    private static void ApplyUpdate()
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            try
            {
                ShowBalloon("Downloading Update...", "Please wait. MidTerm will restart automatically.");

                var response = _httpClient!.PostAsync("api/update/apply", null).GetAwaiter().GetResult();

                if (response.IsSuccessStatusCode)
                {
                    Thread.Sleep(1000);
                    PostMessage(_hwnd, WM_DESTROY, IntPtr.Zero, IntPtr.Zero);
                }
                else
                {
                    ShowBalloon("Update Failed", $"Server returned {response.StatusCode}");
                }
            }
            catch (Exception ex)
            {
                ShowBalloon("Update Failed", ex.Message);
            }
        });
    }

    private static void CloseAllSessions()
    {
        if (_sessions is null || _sessions.Count == 0)
        {
            return;
        }

        var result = MessageBox(_hwnd,
            $"Close all {_sessions.Count} terminal session(s)?\n\nThis will terminate any running processes.",
            "Confirm Close Sessions",
            MB_YESNO | MB_ICONWARNING);

        if (result == IDYES)
        {
            var closedCount = 0;
            foreach (var session in _sessions)
            {
                try
                {
                    var response = _httpClient!.DeleteAsync($"api/sessions/{session.Id}").GetAwaiter().GetResult();
                    if (response.IsSuccessStatusCode)
                    {
                        closedCount++;
                    }
                }
                catch
                {
                }
            }

            ShowBalloon("Sessions Closed", $"Closed {closedCount} session(s).");
        }
    }

    private static void CloseApplication()
    {
        var sessionCount = _sessions?.Count ?? 0;
        var message = sessionCount > 0
            ? $"Close MidTerm?\n\nThis will also close {sessionCount} active terminal session(s)."
            : "Close MidTerm?";

        var result = MessageBox(_hwnd, message, "Confirm Close", MB_YESNO | MB_ICONQUESTION);

        if (result == IDYES)
        {
            try
            {
                _httpClient!.PostAsync("api/shutdown", null).GetAwaiter().GetResult();
            }
            catch
            {
            }

            PostMessage(_hwnd, WM_DESTROY, IntPtr.Zero, IntPtr.Zero);
        }
    }

    private static void ShowBalloon(string title, string message)
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

    #region P/Invoke

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint dwExStyle, string lpClassName, string lpWindowName, uint dwStyle, int x, int y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

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

    #endregion
}
#endif
