using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Ai.Tlbx.MidTerm.Services.Certificates;

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
        if (useEcdsa)
        {
            using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP384);
            var request = new CertificateRequest(
                CertificateSubject,
                ecdsa,
                HashAlgorithmName.SHA384);
            return CreateExportableSelfSignedCertificate(request, dnsNames, ipAddresses);
        }

        using var rsa = RSA.Create(4096);
        var rsaRequest = new CertificateRequest(
                CertificateSubject,
                rsa,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1);
        return CreateExportableSelfSignedCertificate(rsaRequest, dnsNames, ipAddresses);
    }

    private static X509Certificate2 CreateExportableSelfSignedCertificate(
        CertificateRequest request,
        string[] dnsNames,
        string[] ipAddresses)
    {
        request.CertificateExtensions.Add(
            new X509BasicConstraintsExtension(
                certificateAuthority: true,
                hasPathLengthConstraint: true,
                pathLengthConstraint: 0,
                critical: true));

        request.CertificateExtensions.Add(
            new X509KeyUsageExtension(
                X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment | X509KeyUsageFlags.KeyCertSign,
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

        using (cert)
        {
            var exported = cert.Export(X509ContentType.Pfx);
            return X509CertificateLoader.LoadPkcs12(
                exported,
                null,
                X509KeyStorageFlags.Exportable);
        }
    }

    public static byte[] ExportPrivateKeyPkcs8(X509Certificate2 cert)
    {
        using var ecdsa = cert.GetECDsaPrivateKey();
        if (ecdsa is not null)
        {
            return ecdsa.ExportPkcs8PrivateKey();
        }

        using var rsa = cert.GetRSAPrivateKey();
        if (rsa is not null)
        {
            return rsa.ExportPkcs8PrivateKey();
        }

        throw new InvalidOperationException("Failed to export private key");
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
            .Distinct(StringComparer.Ordinal)
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
        Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"  Expires: {DateTime.UtcNow.AddYears(ValidityYears):yyyy-MM-dd}"));
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
