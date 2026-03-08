using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class SessionEndpointDiscovery
{
    public static List<(string sessionId, int hostPid)> GetExistingEndpoints()
    {
        var endpoints = new List<(string, int)>();

        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            foreach (var pipePath in Directory.GetFiles(pipeDir))
            {
                var pipeName = Path.GetFileName(pipePath);
                var parsed = IpcEndpoint.ParseEndpoint(pipeName);
                if (parsed.HasValue)
                {
                    endpoints.Add(parsed.Value);
                }
            }
#else
            var socketDir = IpcEndpoint.GetUnixSocketDirectory();
            if (Directory.Exists(socketDir))
            {
                foreach (var socketPath in Directory.GetFiles(socketDir, $"{IpcEndpoint.Prefix}*.sock"))
                {
                    var parsed = IpcEndpoint.ParseEndpoint(socketPath);
                    if (parsed.HasValue)
                    {
                        endpoints.Add(parsed.Value);
                    }
                }
            }
#endif
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostSessionManager: Endpoint enumeration failed: {ex.Message}");
        }

        return endpoints;
    }

    public static bool EndpointExists(string sessionId, int hostPid)
    {
        try
        {
#if WINDOWS
            var pipeName = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
            var pipeDir = @"\\.\pipe\";
            return Directory.GetFiles(pipeDir, pipeName).Length > 0;
#else
            var socketPath = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
            return File.Exists(socketPath);
#endif
        }
        catch
        {
            return false;
        }
    }

    public static int? FindEndpointPid(string sessionId)
    {
        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            var pattern = $"mthost-{sessionId}-*";
            var matches = Directory.GetFiles(pipeDir, pattern);
            if (matches.Length == 0) return null;

            var pipeName = Path.GetFileName(matches[0]);
            var parts = pipeName.Split('-');
            if (parts.Length >= 3 && int.TryParse(parts[2], out var pid))
            {
                return pid;
            }
#else
            var socketDir = IpcEndpoint.GetUnixSocketDirectory();
            var matches = Directory.GetFiles(socketDir, $"mthost-{sessionId}-*.sock");
            if (matches.Length == 0) return null;

            var fileName = Path.GetFileNameWithoutExtension(matches[0]);
            var parts = fileName.Split('-');
            if (parts.Length >= 3 && int.TryParse(parts[2], out var pid))
            {
                return pid;
            }
#endif
        }
        catch
        {
        }

        return null;
    }

    public static void CleanupEndpoint(string sessionId, int hostPid)
    {
        try
        {
#if WINDOWS
#else
            var socketPath = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
            if (File.Exists(socketPath))
            {
                File.Delete(socketPath);
                Log.Info(() => $"TtyHostSessionManager: Removed stale socket: {socketPath}");
            }
#endif
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostSessionManager: Failed to cleanup endpoint {sessionId}: {ex.Message}");
        }
    }
}
