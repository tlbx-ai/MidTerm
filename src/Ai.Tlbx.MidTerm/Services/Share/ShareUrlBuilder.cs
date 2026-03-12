using System.Net;
using Ai.Tlbx.MidTerm.Models.System;

namespace Ai.Tlbx.MidTerm.Services.Share;

internal static class ShareUrlBuilder
{
    public static string BuildShareUrl(
        HttpRequest request,
        IReadOnlyList<NetworkInterfaceDto> networkInterfaces,
        string grantId,
        string secret,
        string? preferredHost = null)
    {
        var host = ResolveShareHost(request.Host.Host, networkInterfaces, preferredHost);
        var builder = CreateBaseUriBuilder(request, host);
        builder.Path = $"/shared/{grantId}";
        builder.Fragment = secret;
        return builder.Uri.AbsoluteUri;
    }

    public static string BuildTrustPageUrl(HttpRequest request, IReadOnlyList<NetworkInterfaceDto> networkInterfaces)
    {
        var host = ResolveShareHost(request.Host.Host, networkInterfaces);
        var builder = CreateBaseUriBuilder(request, host);
        builder.Path = "/trust";
        builder.Fragment = string.Empty;
        return builder.Uri.AbsoluteUri;
    }

    internal static string ResolveShareHost(
        string requestHost,
        IReadOnlyList<NetworkInterfaceDto> networkInterfaces,
        string? preferredHost = null)
    {
        var explicitHost = ResolveExplicitShareHost(preferredHost, requestHost, networkInterfaces);
        if (explicitHost is not null)
        {
            return explicitHost;
        }

        if (IsRoutableRequestHost(requestHost))
        {
            return requestHost;
        }

        var fallback = networkInterfaces
            .Where(n => !string.IsNullOrWhiteSpace(n.Ip) && IsRoutableRequestHost(n.Ip))
            .OrderBy(GetNetworkPriority)
            .ThenBy(n => n.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(n => n.Ip, StringComparer.Ordinal)
            .Select(n => n.Ip)
            .FirstOrDefault();

        return fallback ?? requestHost;
    }

    private static string? ResolveExplicitShareHost(
        string? preferredHost,
        string requestHost,
        IReadOnlyList<NetworkInterfaceDto> networkInterfaces)
    {
        if (string.IsNullOrWhiteSpace(preferredHost))
        {
            return null;
        }

        var normalizedPreferredHost = NormalizeHost(preferredHost);
        var normalizedRequestHost = NormalizeHost(requestHost);

        if (string.Equals(normalizedPreferredHost, normalizedRequestHost, StringComparison.OrdinalIgnoreCase))
        {
            return normalizedPreferredHost;
        }

        var matchesNetwork = networkInterfaces.Any(network =>
            string.Equals(NormalizeHost(network.Ip), normalizedPreferredHost, StringComparison.OrdinalIgnoreCase));

        return matchesNetwork ? normalizedPreferredHost : null;
    }

    private static UriBuilder CreateBaseUriBuilder(HttpRequest request, string host)
    {
        return request.Host.Port.HasValue
            ? new UriBuilder(request.Scheme, host, request.Host.Port.Value)
            : new UriBuilder(request.Scheme, host);
    }

    private static bool IsRoutableRequestHost(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
        {
            return false;
        }

        host = NormalizeHost(host);

        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase) ||
            host.Equals("0.0.0.0", StringComparison.OrdinalIgnoreCase) ||
            host.Equals("::", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!IPAddress.TryParse(host, out var address))
        {
            return true;
        }

        return !IPAddress.IsLoopback(address) && !IPAddress.Any.Equals(address) && !IPAddress.IPv6Any.Equals(address);
    }

    private static string NormalizeHost(string host)
    {
        return host.Trim().Trim('[', ']');
    }

    private static int GetNetworkPriority(NetworkInterfaceDto network)
    {
        if (!IPAddress.TryParse(network.Ip, out var address))
        {
            return 5;
        }

        if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork)
        {
            return 4;
        }

        if (IsPrivateIPv4(address))
        {
            return HasVpnHint(network.Name) ? 2 : 0;
        }

        if (IsLinkLocalIPv4(address))
        {
            return 3;
        }

        return HasVpnHint(network.Name) ? 2 : 1;
    }

    private static bool HasVpnHint(string name)
    {
        return name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
               name.Contains("VPN", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsPrivateIPv4(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        if (bytes.Length != 4)
        {
            return false;
        }

        return bytes[0] == 10
               || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
               || (bytes[0] == 192 && bytes[1] == 168);
    }

    private static bool IsLinkLocalIPv4(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes.Length == 4 && bytes[0] == 169 && bytes[1] == 254;
    }
}
