using System.Security.Cryptography.X509Certificates;
using System.Text;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Startup;

public static class CertificateSetup
{
    /// <summary>
    /// Last error encountered during certificate loading.
    /// Set when LoadOrGenerateCertificate returns null due to an error.
    /// Can be exposed in UI/API for diagnostics.
    /// </summary>
    public static string? LastCertificateError { get; private set; }

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
        settings.CertificateThumbprint = cert.Thumbprint;
        settingsService.Save(settings);

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("Certificate generated successfully!");
        Console.WriteLine($"  Thumbprint: {cert.Thumbprint}");
        Console.ResetColor();

        CertificateGenerator.PrintTrustInstructions(certPath, dnsNames, ipAddresses);
    }

    public static X509Certificate2? LoadOrGenerateCertificate(
        MidTermSettings settings,
        SettingsService settingsService,
        Action<string, bool>? writeEventLog = null)
    {
        LastCertificateError = null;
        var settingsDir = Path.GetDirectoryName(settingsService.SettingsPath) ?? ".";
        const string keyId = "midterm";

        writeEventLog?.Invoke($"LoadOrGenerateCertificate: SettingsDir={settingsDir}, CertPath={settings.CertificatePath}, KeyProtection={settings.KeyProtection}", false);

        if (!string.IsNullOrEmpty(settings.CertificatePath) && File.Exists(settings.CertificatePath))
        {
            writeEventLog?.Invoke($"LoadOrGenerateCertificate: Certificate file exists at {settings.CertificatePath}", false);

            // Pre-flight validation: check key file exists
            var keyPath = OperatingSystem.IsWindows()
                ? Path.Combine(settingsDir, "keys", "midterm.dpapi")
                : Path.Combine(settingsDir, "midterm.key.enc");

            if (!File.Exists(keyPath))
            {
                var msg = $"Private key file missing at {keyPath}";
                writeEventLog?.Invoke($"LoadOrGenerateCertificate: {msg}", true);
                LastCertificateError = msg;
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine($"Warning: {msg}. Run 'mt --generate-cert --force' to regenerate.");
                Console.ResetColor();
                return null;
            }

            var keyFileInfo = new FileInfo(keyPath);
            if (keyFileInfo.Length < 50)
            {
                var msg = $"Key file appears corrupted (size={keyFileInfo.Length} bytes, expected >50)";
                writeEventLog?.Invoke($"LoadOrGenerateCertificate: {msg}", true);
                LastCertificateError = msg;
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine($"Warning: {msg}. Run 'mt --generate-cert --force' to regenerate.");
                Console.ResetColor();
                return null;
            }

            try
            {
                X509Certificate2 cert;
                if (settings.KeyProtection == KeyProtectionMethod.OsProtected)
                {
                    // Use persisted flag with runtime detection as fallback for existing installs
                    // This ensures DPAPI scope is consistent between installer and runtime
                    var isServiceInstall = settings.IsServiceInstall || settingsService.IsRunningAsService;
                    writeEventLog?.Invoke($"LoadOrGenerateCertificate: Loading with OS-protected key, IsServiceInstall={settings.IsServiceInstall}, RuntimeIsService={settingsService.IsRunningAsService}, UsingScope={isServiceInstall}", false);
                    var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, isServiceInstall);
                    cert = protector.LoadCertificateWithPrivateKey(settings.CertificatePath, keyId);
                }
                else
                {
                    writeEventLog?.Invoke("LoadOrGenerateCertificate: Loading legacy PFX", false);
                    cert = X509CertificateLoader.LoadPkcs12FromFile(
                        settings.CertificatePath,
                        settings.CertificatePassword);
                }

                writeEventLog?.Invoke($"LoadOrGenerateCertificate: Successfully loaded certificate - HasPrivateKey={cert.HasPrivateKey}, Thumbprint={cert.Thumbprint[..8]}...", false);

                // Verify thumbprint matches saved value (detect silent regeneration)
                if (settings.CertificateThumbprint is not null &&
                    cert.Thumbprint != settings.CertificateThumbprint)
                {
                    var warnMsg = $"WARNING: Certificate thumbprint mismatch! Expected={settings.CertificateThumbprint[..8]}..., Got={cert.Thumbprint[..8]}.... Cert may have been silently regenerated.";
                    writeEventLog?.Invoke(warnMsg, true);
                    Console.ForegroundColor = ConsoleColor.Yellow;
                    Console.WriteLine(warnMsg);
                    Console.ResetColor();
                }
                else if (settings.CertificateThumbprint is null)
                {
                    // First load after upgrade - save thumbprint for future verification
                    settings.CertificateThumbprint = cert.Thumbprint;
                    settingsService.Save(settings);
                    writeEventLog?.Invoke($"LoadOrGenerateCertificate: Saved thumbprint to settings: {cert.Thumbprint[..8]}...", false);
                }

                return cert;
            }
            catch (Exception ex)
            {
                var diagnostic = new StringBuilder();
                diagnostic.AppendLine($"Certificate load failed: {ex.GetType().Name}: {ex.Message}");
                diagnostic.AppendLine($"  CertificatePath: {settings.CertificatePath}");
                diagnostic.AppendLine($"  KeyProtection: {settings.KeyProtection}");
                diagnostic.AppendLine($"  IsServiceInstall: {settings.IsServiceInstall}");
                diagnostic.AppendLine($"  RuntimeIsService: {settingsService.IsRunningAsService}");
                diagnostic.AppendLine($"  Cert file exists: {File.Exists(settings.CertificatePath)}");
                diagnostic.AppendLine($"  Key file exists: {File.Exists(keyPath)}");
                if (File.Exists(keyPath))
                {
                    diagnostic.AppendLine($"  Key file size: {new FileInfo(keyPath).Length} bytes");
                }
                if (ex.InnerException is not null)
                {
                    diagnostic.AppendLine($"  Inner: {ex.InnerException.GetType().Name}: {ex.InnerException.Message}");
                }

                LastCertificateError = diagnostic.ToString();
                writeEventLog?.Invoke($"LoadOrGenerateCertificate: FAILED\n{LastCertificateError}", true);

                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine(LastCertificateError);
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

            // Use persisted flag with runtime detection as fallback
            var isServiceInstall = settings.IsServiceInstall || settingsService.IsRunningAsService;
            var protector = Services.Security.CertificateProtectorFactory.Create(settingsDir, isServiceInstall);
            var privateKeyBytes = cert.GetECDsaPrivateKey()?.ExportPkcs8PrivateKey()
                                  ?? cert.GetRSAPrivateKey()?.ExportPkcs8PrivateKey()
                                  ?? throw new InvalidOperationException("Failed to export private key");
            protector.StorePrivateKey(privateKeyBytes, keyId);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(privateKeyBytes);

            var loadedCert = protector.LoadCertificateWithPrivateKey(certPath, keyId);

            settings.CertificatePath = certPath;
            settings.CertificatePassword = null;
            settings.KeyProtection = KeyProtectionMethod.OsProtected;
            settings.CertificateThumbprint = loadedCert.Thumbprint;
            settingsService.Save(settings);

            writeEventLog?.Invoke($"LoadOrGenerateCertificate: Generated new certificate, Thumbprint={loadedCert.Thumbprint[..8]}...", false);

            CertificateGenerator.PrintTrustInstructions(certPath, dnsNames, ipAddresses);

            return loadedCert;
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
