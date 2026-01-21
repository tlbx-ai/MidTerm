using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Ai.Tlbx.MidTerm.Services;

public static class CertificateGenerator
{
    private const int ValidityYears = 2;

    /// <summary>
    /// The CN used for certificates. Uses reverse-DNS style to avoid collisions with other apps.
    /// This is the single source of truth - all code should reference this constant.
    /// </summary>
    public const string CertificateSubject = "CN=ai.tlbx.midterm";

    public static X509Certificate2 GenerateSelfSigned(string[] dnsNames, string[] ipAddresses, bool useEcdsa = true)
    {
        AsymmetricAlgorithm key;
        CertificateRequest request;

        if (useEcdsa)
        {
            var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            key = ecdsa;
            request = new CertificateRequest(
                CertificateSubject,
                ecdsa,
                HashAlgorithmName.SHA384);
        }
        else
        {
            var rsa = RSA.Create(4096);
            key = rsa;
            request = new CertificateRequest(
                CertificateSubject,
                rsa,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1);
        }

        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment,
                critical: true));

        request.CertificateExtensions.Add(
            new X509EnhancedKeyUsageExtension(
                [new Oid("1.3.6.1.5.5.7.3.1")], // serverAuth
                critical: false));

        var sanBuilder = new SubjectAlternativeNameBuilder();
        foreach (var dns in dnsNames)
        {
            sanBuilder.AddDnsName(dns);
        }
        foreach (var ip in ipAddresses)
        {
            if (IPAddress.TryParse(ip, out var addr))
            {
                sanBuilder.AddIpAddress(addr);
            }
        }
        request.CertificateExtensions.Add(sanBuilder.Build());

        var cert = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddDays(-1),
            DateTimeOffset.UtcNow.AddYears(ValidityYears));

        // Return with exportable private key
        return cert;
    }

    public static void ExportToPfx(X509Certificate2 cert, string path, string? password)
    {
        var pfxBytes = cert.Export(X509ContentType.Pfx, password);
        File.WriteAllBytes(path, pfxBytes);
    }

    public static void ExportPublicCertToPem(X509Certificate2 cert, string path)
    {
        var pem = cert.ExportCertificatePem();
        File.WriteAllText(path, pem);
    }

    public static string[] GetLocalIPAddresses()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(ni => ni.OperationalStatus == OperationalStatus.Up
                         && ni.NetworkInterfaceType != NetworkInterfaceType.Loopback
                         && IsPhysicalOrVpn(ni.Name))
            .SelectMany(ni => ni.GetIPProperties().UnicastAddresses
                .Where(addr => addr.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(addr => addr.Address.ToString()))
            .Distinct()
            .ToArray();
    }

    public static string[] GetDnsNames()
    {
        var names = new List<string> { "localhost" };
        try
        {
            var hostName = Dns.GetHostName();
            if (!string.IsNullOrEmpty(hostName) && !names.Contains(hostName, StringComparer.OrdinalIgnoreCase))
            {
                names.Add(hostName);
            }
        }
        catch
        {
            // Ignore hostname resolution failures
        }
        return names.ToArray();
    }

    private static bool IsPhysicalOrVpn(string name)
    {
        // Always include VPN/Tailscale adapters
        if (name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("VPN", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // Exclude known virtual adapters
        if (name.Contains("VMware", StringComparison.OrdinalIgnoreCase) ||
            name.StartsWith("vEthernet", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) ||
            name.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return true;
    }

    public static void PrintTrustInstructions(string certPath, string[] dnsNames, string[] ipAddresses)
    {
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("  Self-signed certificate generated");
        Console.ResetColor();
        Console.WriteLine($"  Location: {certPath}");
        Console.WriteLine($"  Valid for: {string.Join(", ", dnsNames.Concat(ipAddresses))}");
        Console.WriteLine($"  Expires: {DateTime.UtcNow.AddYears(ValidityYears):yyyy-MM-dd}");
        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("  WARNING: Browser will show security warning until certificate is trusted.");
        Console.ResetColor();
        Console.WriteLine();

        if (OperatingSystem.IsWindows())
        {
            Console.WriteLine("  To trust on Windows (run as Administrator):");
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine($"    certutil -addstore Root \"{certPath}\"");
            Console.ResetColor();
        }
        else if (OperatingSystem.IsMacOS())
        {
            var pemPath = Path.ChangeExtension(certPath, ".pem");
            Console.WriteLine("  To trust on macOS:");
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine($"    openssl pkcs12 -in \"{certPath}\" -out \"{pemPath}\" -nodes -password pass:");
            Console.WriteLine($"    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"{pemPath}\"");
            Console.ResetColor();
        }
        else
        {
            var pemPath = Path.ChangeExtension(certPath, ".pem");
            Console.WriteLine("  To trust on Linux:");
            Console.ForegroundColor = ConsoleColor.Cyan;
            Console.WriteLine($"    openssl pkcs12 -in \"{certPath}\" -out \"{pemPath}\" -nodes -password pass:");
            Console.WriteLine($"    sudo cp \"{pemPath}\" /usr/local/share/ca-certificates/midterm.crt");
            Console.WriteLine("    sudo update-ca-certificates");
            Console.ResetColor();
        }
        Console.WriteLine();
    }
}
