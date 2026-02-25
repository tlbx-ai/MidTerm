using System.Net.NetworkInformation;
using System.Net.Sockets;
using Ai.Tlbx.MidTerm.Models.System;

namespace Ai.Tlbx.MidTerm.Services;

public static class NetworkInterfaceFilter
{
    public static bool IsPhysicalOrVpn(string name)
    {
        if (name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("VPN", StringComparison.OrdinalIgnoreCase))
            return true;

        if (name.Contains("VMware", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("vEthernet", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase))
            return false;

        return true;
    }

    public static List<NetworkInterfaceDto> GetNetworkInterfaces()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(ni => ni.OperationalStatus == OperationalStatus.Up
                         && ni.NetworkInterfaceType != NetworkInterfaceType.Loopback
                         && IsPhysicalOrVpn(ni.Name))
            .SelectMany(ni => ni.GetIPProperties().UnicastAddresses
                .Where(addr => addr.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(addr => new NetworkInterfaceDto
                {
                    Name = ni.Name,
                    Ip = addr.Address.ToString()
                }))
            .Prepend(new NetworkInterfaceDto { Name = "Localhost", Ip = "localhost" })
            .ToList();
    }
}
