using System.Globalization;

namespace Ai.Tlbx.MidTerm.Common.Ipc;

public static class LensHostEndpoint
{
    public const string Prefix = "mtagenthost-";

    public static string GetSessionEndpoint(string instanceId, string sessionId, int pid)
    {
        var endpointName = BuildEndpointName(instanceId, sessionId, pid);
        if (OperatingSystem.IsWindows())
        {
            return endpointName;
        }

        return Path.Combine(IpcEndpoint.GetUnixSocketDirectory(), $"{endpointName}.sock");
    }

    public static string BuildEndpointName(string instanceId, string sessionId, int pid)
    {
        return string.Create(CultureInfo.InvariantCulture, $"{Prefix}{instanceId}-{sessionId}-{pid}");
    }

    public static (string? instanceId, string sessionId, int pid)? ParseEndpoint(string endpointName)
    {
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
        if (segments.Length != 3 || !int.TryParse(segments[2], CultureInfo.InvariantCulture, out var pid))
        {
            return null;
        }

        return (segments[0], segments[1], pid);
    }
}
