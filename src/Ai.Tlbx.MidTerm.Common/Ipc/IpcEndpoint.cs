using System.Runtime.InteropServices;

namespace Ai.Tlbx.MidTerm.Common.Ipc;

/// <summary>
/// Platform-specific IPC endpoint resolution.
/// Windows: Named pipes
/// Unix: Unix domain sockets
/// Format: mthost-{sessionId}-{pid}
/// </summary>
public static class IpcEndpoint
{
    public const string Prefix = "mthost-";

    /// <summary>
    /// Get the IPC endpoint name/path for a session.
    /// </summary>
    public static string GetSessionEndpoint(string sessionId, int pid)
    {
        if (OperatingSystem.IsWindows())
        {
            return $"{Prefix}{sessionId}-{pid}";
        }
        else
        {
            var socketDir = GetUnixSocketDirectory();
            return Path.Combine(socketDir, $"{Prefix}{sessionId}-{pid}.sock");
        }
    }

    private static string GetUnixSocketDirectory()
    {
        var uid = GetUnixUid();
        var dir = $"/tmp/midterm-{uid}";
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
    public static (string sessionId, int pid)? ParseEndpoint(string endpointName)
    {
        // Strip path and extension for Unix sockets
        var name = Path.GetFileNameWithoutExtension(endpointName);
        if (string.IsNullOrEmpty(name))
        {
            name = endpointName;
        }

        if (!name.StartsWith(Prefix))
        {
            return null;
        }

        var remainder = name[Prefix.Length..];
        var lastDash = remainder.LastIndexOf('-');
        if (lastDash <= 0)
        {
            return null;
        }

        var sessionId = remainder[..lastDash];
        var pidStr = remainder[(lastDash + 1)..];

        if (!int.TryParse(pidStr, out var pid))
        {
            return null;
        }

        return (sessionId, pid);
    }

    /// <summary>
    /// Check if the endpoint is a Unix socket (path) vs named pipe (name only).
    /// </summary>
    public static bool IsUnixSocket => !OperatingSystem.IsWindows();
}
