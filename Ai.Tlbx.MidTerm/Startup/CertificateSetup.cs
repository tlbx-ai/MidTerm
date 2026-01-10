using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class CertificateSetup
{
    public static void GenerateCertificateCommand(bool force, bool serviceMode)
    {
        var settingsService = new SettingsService();
        var settings = settingsService.Load();

        string settingsDir;
        if (serviceMode)
        {
            if (OperatingSystem.IsWindows())
            {
                var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                settingsDir = Path.Combine(programData, "MidTerm");
            }
            else
            {
                settingsDir = "/usr/local/etc/midterm";
            }
            Directory.CreateDirectory(settingsDir);
        }
        else
        {
            settingsDir = Path.GetDirectoryName(settingsService.SettingsPath) ?? ".";
        }

        var certPath = Path.Combine(settingsDir, "midterm.pem");
        var keyId = "midterm";

        if (File.Exists(certPath) && !force)
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("Certificate already exists. Use --force to regenerate.");
            Console.ResetColor();
            Console.WriteLine($"  Path: {certPath}");
            return;
        }

        Console.WriteLine("Generating self-signed certificate...");

        var dnsNames = CertificateGenerator.GetDnsNames();
        var ipAddresses = CertificateGenerator.GetLocalIPAddresses();

        Console.WriteLine($"  DNS names: {string.Join(", ", dnsNames)}");
        Console.WriteLine($"  IP addresses: {string.Join(", ", ipAddresses)}");

        var cert = CertificateGenerator.GenerateSelfSigned(dnsNames, ipAddresses, useEcdsa: true);

        CertificateGenerator.ExportPublicCertToPem(cert, certPath);

        var isService = serviceMode || settingsService.IsRunningAsService;
        var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, isService);
        var privateKeyBytes = cert.GetECDsaPrivateKey()?.ExportPkcs8PrivateKey()
                              ?? cert.GetRSAPrivateKey()?.ExportPkcs8PrivateKey()
                              ?? throw new InvalidOperationException("Failed to export private key");
        protector.StorePrivateKey(privateKeyBytes, keyId);
        System.Security.Cryptography.CryptographicOperations.ZeroMemory(privateKeyBytes);

        settings.CertificatePath = certPath;
        settings.CertificatePassword = null;
        settings.KeyProtection = KeyProtectionMethod.OsProtected;
        settingsService.Save(settings);

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("Certificate generated successfully!");
        Console.ResetColor();

        CertificateGenerator.PrintTrustInstructions(certPath, dnsNames, ipAddresses);
    }

    public static X509Certificate2? LoadOrGenerateCertificate(
        MidTermSettings settings,
        SettingsService settingsService,
        Action<string, bool>? writeEventLog = null)
    {
        var settingsDir = Path.GetDirectoryName(settingsService.SettingsPath) ?? ".";
        const string keyId = "midterm";

        writeEventLog?.Invoke($"LoadOrGenerateCertificate: SettingsDir={settingsDir}, CertPath={settings.CertificatePath}, KeyProtection={settings.KeyProtection}", false);

        if (!string.IsNullOrEmpty(settings.CertificatePath) && File.Exists(settings.CertificatePath))
        {
            writeEventLog?.Invoke($"LoadOrGenerateCertificate: Certificate file exists at {settings.CertificatePath}", false);

            try
            {
                if (settings.KeyProtection == KeyProtectionMethod.OsProtected)
                {
                    writeEventLog?.Invoke($"LoadOrGenerateCertificate: Loading with OS-protected key, IsService={settingsService.IsRunningAsService}", false);
                    var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, settingsService.IsRunningAsService);
                    var cert = protector.LoadCertificateWithPrivateKey(settings.CertificatePath, keyId);
                    writeEventLog?.Invoke($"LoadOrGenerateCertificate: Successfully loaded certificate - HasPrivateKey={cert.HasPrivateKey}", false);
                    return cert;
                }
                else
                {
                    writeEventLog?.Invoke("LoadOrGenerateCertificate: Loading legacy PFX", false);
                    return X509CertificateLoader.LoadPkcs12FromFile(
                        settings.CertificatePath,
                        settings.CertificatePassword);
                }
            }
            catch (Exception ex)
            {
                writeEventLog?.Invoke($"LoadOrGenerateCertificate: FAILED - {ex.GetType().Name}: {ex.Message}", true);
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine($"Error: Failed to load HTTPS certificate: {ex.Message}");
                Console.ResetColor();
                return null;
            }
        }

        Console.WriteLine("  No certificate found. Generating self-signed certificate...");

        try
        {
            var certPath = Path.Combine(settingsDir, "midterm.pem");
            var dnsNames = CertificateGenerator.GetDnsNames();
            var ipAddresses = CertificateGenerator.GetLocalIPAddresses();

            var cert = CertificateGenerator.GenerateSelfSigned(dnsNames, ipAddresses, useEcdsa: true);

            CertificateGenerator.ExportPublicCertToPem(cert, certPath);

            var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, settingsService.IsRunningAsService);
            var privateKeyBytes = cert.GetECDsaPrivateKey()?.ExportPkcs8PrivateKey()
                                  ?? cert.GetRSAPrivateKey()?.ExportPkcs8PrivateKey()
                                  ?? throw new InvalidOperationException("Failed to export private key");
            protector.StorePrivateKey(privateKeyBytes, keyId);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(privateKeyBytes);

            settings.CertificatePath = certPath;
            settings.CertificatePassword = null;
            settings.KeyProtection = KeyProtectionMethod.OsProtected;
            settingsService.Save(settings);

            CertificateGenerator.PrintTrustInstructions(certPath, dnsNames, ipAddresses);

            return protector.LoadCertificateWithPrivateKey(certPath, keyId);
        }
        catch (Exception ex)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.WriteLine($"Error: Failed to generate HTTPS certificate: {ex.Message}");
            Console.ResetColor();
            return null;
        }
    }
}
