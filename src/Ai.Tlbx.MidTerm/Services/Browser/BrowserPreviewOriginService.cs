using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserPreviewOriginService
{
    public int MainPort { get; }
    public int PreviewPort { get; }
    public bool IsEnabled { get; }

    public BrowserPreviewOriginService(int mainPort, int previewPort, bool isEnabled)
    {
        MainPort = mainPort;
        PreviewPort = previewPort;
        IsEnabled = isEnabled;
    }

    public static BrowserPreviewOriginService Create(int mainPort, string bindAddress)
    {
        var previewPort = mainPort >= 65535 ? 0 : mainPort + 1;
        var enabled = previewPort > 0 && CanBind(bindAddress, previewPort);
        return new BrowserPreviewOriginService(mainPort, previewPort, enabled);
    }

    public void ApplyUrls(WebApplication app, string bindAddress)
    {
        if (!IsEnabled)
        {
            return;
        }

        app.Urls.Add(string.Create(CultureInfo.InvariantCulture, $"https://{bindAddress}:{PreviewPort}"));
    }

    public string? GetOrigin(HttpRequest request)
    {
        if (!IsEnabled)
        {
            return null;
        }

        var host = request.Host.Host;
        if (string.IsNullOrWhiteSpace(host))
        {
            return null;
        }

        return string.Create(CultureInfo.InvariantCulture, $"{request.Scheme}://{host}:{PreviewPort}");
    }

    public bool IsPreviewRequest(HttpContext context)
    {
        return IsEnabled && context.Request.Host.Port == PreviewPort;
    }

    public bool ShouldBlockPath(string path)
    {
        if (!IsEnabled)
        {
            return false;
        }

        if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (path.StartsWith("/ws/", StringComparison.OrdinalIgnoreCase)
            && !path.Equals("/ws/browser", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return path is "/"
            or "/index.html"
            or "/login.html"
            or "/trust"
            or "/trust.html"
            or "/web-preview-popup.html"
            or "/midFont-style.css"
            or "/site.webmanifest"
            or "/THIRD-PARTY-LICENSES.txt";
    }

    private static bool CanBind(string bindAddress, int port)
    {
        try
        {
            var address = ParseBindAddress(bindAddress);
            using var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
            if (address.AddressFamily == AddressFamily.InterNetworkV6)
            {
                socket.SetSocketOption(SocketOptionLevel.IPv6, SocketOptionName.IPv6Only, true);
            }

            socket.Bind(new IPEndPoint(address, port));
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static IPAddress ParseBindAddress(string bindAddress)
    {
        if (string.IsNullOrWhiteSpace(bindAddress) || bindAddress == "*" || bindAddress == "0.0.0.0")
        {
            return IPAddress.Any;
        }

        if (bindAddress == "::" || bindAddress == "[::]" || bindAddress == "+")
        {
            return IPAddress.IPv6Any;
        }

        return IPAddress.TryParse(bindAddress, out var parsed)
            ? parsed
            : IPAddress.Any;
    }
}
