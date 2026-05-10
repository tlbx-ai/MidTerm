using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal static class AppServerControlHostEndpointDiscovery
{
    public static List<(string sessionId, int hostPid)> GetExistingEndpoints(string instanceId)
    {
        var endpoints = new List<(string, int)>();

        try
        {
            if (OperatingSystem.IsWindows())
            {
                var pipeDir = @"\\.\pipe\";
                foreach (var pipePath in Directory.GetFiles(pipeDir, $"{AppServerControlHostEndpoint.Prefix}{instanceId}-*"))
                {
                    var parsed = AppServerControlHostEndpoint.ParseEndpoint(Path.GetFileName(pipePath));
                    if (parsed.HasValue &&
                        string.Equals(parsed.Value.instanceId, instanceId, StringComparison.Ordinal))
                    {
                        endpoints.Add((parsed.Value.sessionId, parsed.Value.pid));
                    }
                }
            }
            else
            {
                var socketDir = IpcEndpoint.GetUnixSocketDirectory();
                if (Directory.Exists(socketDir))
                {
                    foreach (var socketPath in Directory.GetFiles(socketDir, $"{AppServerControlHostEndpoint.Prefix}{instanceId}-*.sock"))
                    {
                        var parsed = AppServerControlHostEndpoint.ParseEndpoint(socketPath);
                        if (parsed.HasValue &&
                            string.Equals(parsed.Value.instanceId, instanceId, StringComparison.Ordinal))
                        {
                            endpoints.Add((parsed.Value.sessionId, parsed.Value.pid));
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"AppServerControlHostEndpointDiscovery enumeration failed: {ex.Message}");
        }

        return endpoints;
    }

    public static bool EndpointExists(string instanceId, string sessionId, int hostPid)
    {
        try
        {
            return OperatingSystem.IsWindows()
                ? Directory.GetFiles(@"\\.\pipe\", AppServerControlHostEndpoint.GetSessionEndpoint(instanceId, sessionId, hostPid)).Length > 0
                : File.Exists(AppServerControlHostEndpoint.GetSessionEndpoint(instanceId, sessionId, hostPid));
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
            if (OperatingSystem.IsWindows())
            {
                var matches = Directory.GetFiles(@"\\.\pipe\", $"{AppServerControlHostEndpoint.Prefix}{instanceId}-{sessionId}-*");
                if (matches.Length == 0)
                {
                    return null;
                }

                return AppServerControlHostEndpoint.ParseEndpoint(Path.GetFileName(matches[0]))?.pid;
            }

            var socketDir = IpcEndpoint.GetUnixSocketDirectory();
            if (!Directory.Exists(socketDir))
            {
                return null;
            }

            var socketMatches = Directory.GetFiles(socketDir, $"{AppServerControlHostEndpoint.Prefix}{instanceId}-{sessionId}-*.sock");
            if (socketMatches.Length == 0)
            {
                return null;
            }

            return AppServerControlHostEndpoint.ParseEndpoint(socketMatches[0])?.pid;
        }
        catch
        {
            return null;
        }
    }

    public static void CleanupEndpoint(string instanceId, string sessionId, int hostPid)
    {
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                var socketPath = AppServerControlHostEndpoint.GetSessionEndpoint(instanceId, sessionId, hostPid);
                if (File.Exists(socketPath))
                {
                    File.Delete(socketPath);
                    Log.Info(() => $"AppServerControlHostEndpointDiscovery: Removed stale socket: {socketPath}");
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"AppServerControlHostEndpointDiscovery cleanup failed for {sessionId}: {ex.Message}");
        }
    }
}
