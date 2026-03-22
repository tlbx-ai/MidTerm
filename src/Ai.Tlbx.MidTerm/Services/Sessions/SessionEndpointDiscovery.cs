using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class SessionEndpointDiscovery
{
    public static List<(string sessionId, int hostPid)> GetExistingEndpoints(string instanceId)
    {
        var endpoints = new List<(string, int)>();

        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            foreach (var pipePath in Directory.GetFiles(pipeDir, $"{IpcEndpoint.Prefix}{instanceId}-*"))
            {
                var pipeName = Path.GetFileName(pipePath);
                var parsed = IpcEndpoint.ParseEndpoint(pipeName);
                if (parsed.HasValue &&
                    string.Equals(parsed.Value.instanceId, instanceId, StringComparison.Ordinal))
                {
                    endpoints.Add((parsed.Value.sessionId, parsed.Value.pid));
                }
            }
#else
            var socketDir = IpcEndpoint.GetUnixSocketDirectory();
            if (Directory.Exists(socketDir))
            {
                foreach (var socketPath in Directory.GetFiles(socketDir, $"{IpcEndpoint.Prefix}{instanceId}-*.sock"))
                {
                    var parsed = IpcEndpoint.ParseEndpoint(socketPath);
                    if (parsed.HasValue &&
                        string.Equals(parsed.Value.instanceId, instanceId, StringComparison.Ordinal))
                    {
                        endpoints.Add((parsed.Value.sessionId, parsed.Value.pid));
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

    public static List<(string sessionId, int hostPid)> GetLegacyEndpoints()
    {
        var endpoints = new List<(string, int)>();

        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            foreach (var pipePath in Directory.GetFiles(pipeDir, $"{IpcEndpoint.Prefix}*"))
            {
                var parsed = IpcEndpoint.ParseEndpoint(Path.GetFileName(pipePath));
                if (parsed.HasValue && string.IsNullOrEmpty(parsed.Value.instanceId))
                {
                    endpoints.Add((parsed.Value.sessionId, parsed.Value.pid));
                }
            }
#else
            var socketDir = IpcEndpoint.GetUnixSocketDirectory();
            if (Directory.Exists(socketDir))
            {
                foreach (var socketPath in Directory.GetFiles(socketDir, $"{IpcEndpoint.Prefix}*.sock"))
                {
                    var parsed = IpcEndpoint.ParseEndpoint(socketPath);
                    if (parsed.HasValue && string.IsNullOrEmpty(parsed.Value.instanceId))
                    {
                        endpoints.Add((parsed.Value.sessionId, parsed.Value.pid));
                    }
                }
            }
#endif
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostSessionManager: Legacy endpoint enumeration failed: {ex.Message}");
        }

        return endpoints;
    }

    public static bool EndpointExists(string instanceId, string sessionId, int hostPid)
    {
        try
        {
#if WINDOWS
            var pipeName = IpcEndpoint.GetSessionEndpoint(instanceId, sessionId, hostPid);
            var pipeDir = @"\\.\pipe\";
            return Directory.GetFiles(pipeDir, pipeName).Length > 0;
#else
            var socketPath = IpcEndpoint.GetSessionEndpoint(instanceId, sessionId, hostPid);
            return File.Exists(socketPath);
#endif
        }
        catch
        {
            return false;
        }
    }

    public static int? FindEndpointPid(string instanceId, string sessionId)
    {
        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            var pattern = $"{IpcEndpoint.Prefix}{instanceId}-{sessionId}-*";
            var matches = Directory.GetFiles(pipeDir, pattern);
            if (matches.Length == 0) return null;

            return IpcEndpoint.ParseEndpoint(Path.GetFileName(matches[0]))?.pid;
#else
            var socketDir = IpcEndpoint.GetUnixSocketDirectory();
            var matches = Directory.GetFiles(socketDir, $"{IpcEndpoint.Prefix}{instanceId}-{sessionId}-*.sock");
            if (matches.Length == 0) return null;

            return IpcEndpoint.ParseEndpoint(matches[0])?.pid;
#endif
        }
        catch
        {
        }

        return null;
    }

    public static void CleanupEndpoint(string instanceId, string sessionId, int hostPid, bool legacy = false)
    {
        try
        {
#if WINDOWS
#else
            var socketPath = legacy
                ? IpcEndpoint.GetLegacySessionEndpoint(sessionId, hostPid)
                : IpcEndpoint.GetSessionEndpoint(instanceId, sessionId, hostPid);
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
