using System.Globalization;
using System.Text;
#if WINDOWS
using System.Threading;
#endif
using Ai.Tlbx.MidTerm.Settings;

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
        SingleInstanceGuard? guard = new(instanceKey);

        try
        {
            if (guard.TryAcquireInternal(out existingInfo))
            {
                var acquiredGuard = guard;
                guard = null;
                return acquiredGuard;
            }

            return null;
        }
        finally
        {
            guard?.Dispose();
        }
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
            _mutex?.Dispose();
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
        FileStream? pidFile = null;

        try
        {
            if (!string.IsNullOrEmpty(pidDir) && !Directory.Exists(pidDir))
            {
                Directory.CreateDirectory(pidDir);
            }

            pidFile = new FileStream(
                pidPath,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None);

            // Check if there's an existing PID and if that process is still running
            pidFile.Seek(0, SeekOrigin.Begin);
            using var reader = new StreamReader(pidFile, leaveOpen: true);
            var content = reader.ReadToEnd().Trim();

            if (int.TryParse(content, NumberStyles.None, CultureInfo.InvariantCulture, out var existingPid) &&
                IsProcessRunning(existingPid))
            {
                existingInfo = string.Create(
                    CultureInfo.InvariantCulture,
                    $"Another mt.exe instance is already running (PID: {existingPid})");
                pidFile.Dispose();
                pidFile = null;
                return false;
            }

            // Write our PID
            pidFile.SetLength(0);
            pidFile.Seek(0, SeekOrigin.Begin);
            using var writer = new StreamWriter(pidFile, leaveOpen: true);
            writer.Write(Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
            writer.Flush();

            _pidFile?.Dispose();
            _pidFile = pidFile;
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
        finally
        {
            if (!ReferenceEquals(pidFile, _pidFile))
            {
                pidFile?.Dispose();
            }
        }
    }

    private static string GetPidFilePath(string instanceKey)
    {
        if (TryGetUnixServiceLockDirectory(out var serviceLockDirectory))
        {
            return Path.Combine(serviceLockDirectory, $"midterm-{instanceKey}.pid");
        }

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

    internal static bool TryGetUnixServiceLockDirectory(out string lockDirectory)
    {
        lockDirectory = string.Empty;

        if (OperatingSystem.IsWindows() || !string.IsNullOrWhiteSpace(SettingsService.GetSettingsDirectoryOverride()))
        {
            return false;
        }

        const string serviceSettingsDirectory = "/usr/local/etc/midterm";
        var serviceSettingsPath = Path.Combine(serviceSettingsDirectory, "settings.json");
        if (!File.Exists(serviceSettingsPath))
        {
            return false;
        }

        var candidate = Path.Combine(serviceSettingsDirectory, "locks");
        try
        {
            Directory.CreateDirectory(candidate);
            var probePath = Path.Combine(candidate, $".lock-probe-{Guid.NewGuid():N}");
            using (File.Open(probePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
            }

            File.Delete(probePath);
            lockDirectory = candidate;
            return true;
        }
        catch
        {
            return false;
        }
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
