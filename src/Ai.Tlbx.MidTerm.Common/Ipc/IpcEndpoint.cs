using System.Globalization;
using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.Common.Ipc;

/// <summary>
/// Platform-specific IPC endpoint resolution.
/// Windows: Named pipes
/// Unix: Unix domain sockets
/// Format: mthost-{instanceId}-{sessionId}-{pid}
/// </summary>
public static class IpcEndpoint
{
    public const string Prefix = "mthost-";

    /// <summary>
     /// Get the IPC endpoint name/path for a session.
     /// </summary>
    public static string GetSessionEndpoint(string instanceId, string sessionId, int pid)
    {
        var endpointName = BuildEndpointName(instanceId, sessionId, pid);
        if (OperatingSystem.IsWindows())
        {
            return endpointName;
        }
        else
        {
            var socketDir = GetUnixSocketDirectory();
            return Path.Combine(socketDir, $"{endpointName}.sock");
        }
    }

    public static string GetLegacySessionEndpoint(string sessionId, int pid)
    {
        if (OperatingSystem.IsWindows())
        {
            return string.Create(CultureInfo.InvariantCulture, $"{Prefix}{sessionId}-{pid}");
        }

        var socketDir = GetUnixSocketDirectory();
        return Path.Combine(socketDir, string.Create(CultureInfo.InvariantCulture, $"{Prefix}{sessionId}-{pid}.sock"));
    }

    public static string BuildEndpointName(string instanceId, string sessionId, int pid)
    {
        return string.Create(CultureInfo.InvariantCulture, $"{Prefix}{instanceId}-{sessionId}-{pid}");
    }

    public static string GetUnixSocketDirectory()
    {
        var uid = GetUnixUid();
        var dir = string.Create(CultureInfo.InvariantCulture, $"/tmp/midterm-{uid}");
        if (!Directory.Exists(dir))
        {
            Directory.CreateDirectory(dir);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(dir,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }
        return dir;
    }

    [DllImport("libc", EntryPoint = "getuid")]
    private static extern uint LibcGetUid();

    private static uint GetUnixUid()
    {
        try
        {
            return LibcGetUid();
        }
        catch
        {
            return (uint)Environment.ProcessId;
        }
    }

    /// <summary>
    /// Parse session ID and PID from an endpoint name.
    /// Returns null if the format doesn't match.
    /// </summary>
    public static (string? instanceId, string sessionId, int pid)? ParseEndpoint(string endpointName)
    {
        // Strip path and extension for Unix sockets
        var name = Path.GetFileNameWithoutExtension(endpointName);
        if (string.IsNullOrEmpty(name))
        {
            name = endpointName;
        }

        if (!name.StartsWith(Prefix, StringComparison.Ordinal))
        {
            return null;
        }

        var remainder = name[Prefix.Length..];
        var segments = remainder.Split('-', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 2 &&
            int.TryParse(segments[1], CultureInfo.InvariantCulture, out var legacyPid))
        {
            return (null, segments[0], legacyPid);
        }

        if (segments.Length != 3 ||
            !int.TryParse(segments[2], CultureInfo.InvariantCulture, out var pid))
        {
            return null;
        }

        return (segments[0], segments[1], pid);
    }

    /// <summary>
    /// Check if the endpoint is a Unix socket (path) vs named pipe (name only).
    /// </summary>
    public static bool IsUnixSocket => !OperatingSystem.IsWindows();
}
