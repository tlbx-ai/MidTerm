using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services.Security;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Certificates;

public static class CertificateService
{
    public static void RegenerateCertificate(SettingsService settingsService)
    {
        var settingsDir = Path.GetDirectoryName(settingsService.SettingsPath) ?? ".";
        var certPath = Path.Combine(settingsDir, "midterm.pem");
        const string keyId = "midterm";

        var isServiceInstall = settingsService.Load().IsServiceInstall || settingsService.IsRunningAsService;
        var protector = CertificateProtectorFactory.Create(settingsDir, isServiceInstall);

        try { protector.DeletePrivateKey(keyId); } catch { }
        if (File.Exists(certPath)) File.Delete(certPath);

        var dnsNames = CertificateGenerator.GetDnsNames();
        var ipAddresses = CertificateGenerator.GetLocalIPAddresses();
        using var cert = CertificateGenerator.GenerateSelfSigned(dnsNames, ipAddresses, useEcdsa: true);
        CertificateGenerator.ExportPublicCertToPem(cert, certPath);

        var privateKeyBytes = CertificateGenerator.ExportPrivateKeyPkcs8(cert);
        try
        {
            protector.StorePrivateKey(privateKeyBytes, keyId);
        }
        finally
        {
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(privateKeyBytes);
        }

        var settings = settingsService.Load();
        settings.CertificatePath = certPath;
        settings.CertificatePassword = null;
        settings.KeyProtection = KeyProtectionMethod.OsProtected;
        settings.CertificateThumbprint = cert.Thumbprint;
        settingsService.Save(settings);

        Log.Info(() => $"Certificate regenerated, Thumbprint={cert.Thumbprint[..8]}...");
    }
}
