using System.Text;
#if WINDOWS
using System.Threading;
#endif

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Ensures only one logical MidTerm instance runs for the same instance key.
/// Uses named mutex on Windows, file lock on Unix.
/// </summary>
public sealed class SingleInstanceGuard : IDisposable
{
#if WINDOWS
    private Mutex? _mutex;
    private bool _ownsMutex;
#else
    private FileStream? _pidFile;
#endif
    private readonly string _instanceKey;
    private bool _disposed;

    private SingleInstanceGuard(string instanceKey)
    {
        _instanceKey = SanitizeInstanceKey(instanceKey);
    }

    public static SingleInstanceGuard? TryAcquire(string instanceKey, out string? existingInfo)
    {
        existingInfo = null;
        var guard = new SingleInstanceGuard(instanceKey);

        if (guard.TryAcquireInternal(out existingInfo))
        {
            return guard;
        }

        guard.Dispose();
        return null;
    }

    private bool TryAcquireInternal(out string? existingInfo)
    {
        existingInfo = null;

#if WINDOWS
        return TryAcquireWindows(out existingInfo);
#else
        return TryAcquireUnix(out existingInfo);
#endif
    }

#if WINDOWS
    private bool TryAcquireWindows(out string? existingInfo)
    {
        existingInfo = null;

        try
        {
            _mutex = new Mutex(true, GetMutexName(), out var createdNew);

            if (createdNew)
            {
                _ownsMutex = true;
                return true;
            }

            existingInfo = "Another mt.exe instance is already running";
            _mutex.Dispose();
            _mutex = null;
            return false;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SingleInstanceGuard] Mutex error: {ex.Message}");
            return true;
        }
    }
#else
    private bool TryAcquireUnix(out string? existingInfo)
    {
        existingInfo = null;

        var pidPath = GetPidFilePath(_instanceKey);
        var pidDir = Path.GetDirectoryName(pidPath);

        try
        {
            if (!string.IsNullOrEmpty(pidDir) && !Directory.Exists(pidDir))
            {
                Directory.CreateDirectory(pidDir);
            }

            _pidFile = new FileStream(
                pidPath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None);

            // Check if there's an existing PID and if that process is still running
            _pidFile.Seek(0, SeekOrigin.Begin);
            using var reader = new StreamReader(_pidFile, leaveOpen: true);
            var content = reader.ReadToEnd().Trim();

            if (int.TryParse(content, out var existingPid) && IsProcessRunning(existingPid))
            {
                existingInfo = $"Another mt.exe instance is already running (PID: {existingPid})";
                _pidFile.Dispose();
                _pidFile = null;
                return false;
            }

            // Write our PID
            _pidFile.SetLength(0);
            _pidFile.Seek(0, SeekOrigin.Begin);
            using var writer = new StreamWriter(_pidFile, leaveOpen: true);
            writer.Write(Environment.ProcessId.ToString());
            writer.Flush();

            return true;
        }
        catch (IOException)
        {
            existingInfo = "Another mt.exe instance is already running (file locked)";
            return false;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[SingleInstanceGuard] PID file error: {ex.Message}");
            return true;
        }
    }

    private static string GetPidFilePath(string instanceKey)
    {
        // Running as root (service mode) - use system location
        if (Environment.GetEnvironmentVariable("USER") == "root" ||
            Environment.GetEnvironmentVariable("EUID") == "0")
        {
            if (OperatingSystem.IsMacOS())
            {
                return $"/usr/local/var/run/midterm-{instanceKey}.pid";
            }
            return $"/var/run/midterm-{instanceKey}.pid";
        }

        // User mode - use home directory
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(home, ".midterm", $"midterm-{instanceKey}.pid");
    }

    private static bool IsProcessRunning(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }
#endif

    private string GetMutexName()
    {
#if DEBUG
        return $"Global\\MidTermDev-{_instanceKey}";
#else
        return $"Global\\MidTerm-{_instanceKey}";
#endif
    }

    private static string SanitizeInstanceKey(string instanceKey)
    {
        if (string.IsNullOrWhiteSpace(instanceKey))
        {
            return "default";
        }

        var builder = new StringBuilder(instanceKey.Length);
        foreach (var ch in instanceKey)
        {
            builder.Append(char.IsLetterOrDigit(ch) ? char.ToLowerInvariant(ch) : '-');
        }

        return builder.ToString().Trim('-');
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

#if WINDOWS
        if (_ownsMutex && _mutex is not null)
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // Mutex may have been released by a different thread or not owned
            }
        }
        _mutex?.Dispose();
#else
        if (_pidFile is not null)
        {
            var path = _pidFile.Name;
            _pidFile.Dispose();
            try { File.Delete(path); } catch { }
        }
#endif
    }
}
