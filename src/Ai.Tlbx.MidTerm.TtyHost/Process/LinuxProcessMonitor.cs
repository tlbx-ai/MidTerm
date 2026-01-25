#if LINUX
using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.TtyHost.Process;

/// <summary>
/// Linux process monitor using simple polling with /proc filesystem.
/// Monitors shell's direct child only.
/// Optimized: reusable buffers for readlink and file reads.
/// </summary>
public sealed class LinuxProcessMonitor : IProcessMonitor
{
    private int _shellPid;
    private int? _currentChildPid;
    private string? _currentCwd;
    private Timer? _timer;
    private bool _disposed;

    // Reusable buffer for readlink (thread-safe via ThreadStatic)
    [ThreadStatic]
    private static byte[]? _linkBuffer;
    private static byte[] LinkBuffer => _linkBuffer ??= new byte[4096];

    public event Action<ForegroundProcessInfo>? OnForegroundChanged;

    public void StartMonitoring(int shellPid)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LinuxProcessMonitor));

        _shellPid = shellPid;
        _timer = new Timer(_ => Poll(), null, 0, 1000);
    }

    public void StopMonitoring()
    {
        _timer?.Dispose();
        _timer = null;
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

    private static int? GetFirstDirectChild(int parentPid)
    {
        var childrenPath = $"/proc/{parentPid}/task/{parentPid}/children";
        try
        {
            if (File.Exists(childrenPath))
            {
                var content = File.ReadAllText(childrenPath).Trim();
                if (!string.IsNullOrEmpty(content))
                {
                    var firstSpace = content.IndexOf(' ');
                    var firstPidStr = firstSpace >= 0 ? content[..firstSpace] : content;
                    if (int.TryParse(firstPidStr, out var childPid))
                        return childPid;
                }
            }
        }
        catch { }
        return null;
    }

    private static string? GetProcessName(int pid)
    {
        try
        {
            var commPath = $"/proc/{pid}/comm";
            return File.Exists(commPath) ? File.ReadAllText(commPath).Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    private static string? GetProcessCwd(int pid)
    {
        try
        {
            return ReadLink($"/proc/{pid}/cwd");
        }
        catch
        {
            return null;
        }
    }

    private static string? GetProcessCommandLine(int pid)
    {
        try
        {
            var cmdlinePath = $"/proc/{pid}/cmdline";
            if (!File.Exists(cmdlinePath)) return null;

            var content = File.ReadAllBytes(cmdlinePath);
            if (content.Length == 0) return null;

            // Replace null bytes with spaces, skip first arg (executable path)
            var firstNull = Array.IndexOf(content, (byte)0);
            if (firstNull < 0 || firstNull >= content.Length - 1) return null;

            var argsStart = firstNull + 1;
            for (int i = argsStart; i < content.Length; i++)
            {
                if (content[i] == 0) content[i] = (byte)' ';
            }

            return Encoding.UTF8.GetString(content, argsStart, content.Length - argsStart).Trim();
        }
        catch
        {
            return null;
        }
    }

    private static string? ReadLink(string path)
    {
        var buffer = LinkBuffer;
        var len = readlink(path, buffer, buffer.Length - 1);
        return len > 0 ? Encoding.UTF8.GetString(buffer, 0, len) : null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopMonitoring();
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int readlink([MarshalAs(UnmanagedType.LPStr)] string path, byte[] buf, int bufsiz);
}
#endif
