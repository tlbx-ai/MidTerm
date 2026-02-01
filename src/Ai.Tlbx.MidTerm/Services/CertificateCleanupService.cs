using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

public static class CertificateCleanupService
{
    private static readonly string[] LegacySubjects =
    [
        "CN=MidTerm",
        "CN=MidTerm.Voice"
    ];

    public static void EnsureCertificateTrust(X509Certificate2 currentCert, Action<string, bool>? writeEventLog = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var currentThumbprint = currentCert.Thumbprint;
        Log.Info(() => $"Certificate trust: current cert {currentCert.Subject}, thumbprint {currentThumbprint[..8]}...");
        writeEventLog?.Invoke($"CertificateTrust: Current cert subject={currentCert.Subject}, thumbprint={currentThumbprint[..8]}...", false);

        try
        {
            using var store = new X509Store(StoreName.Root, StoreLocation.LocalMachine);
            store.Open(OpenFlags.ReadWrite);

            var removedCount = RemoveStaleCertificates(store, currentThumbprint, writeEventLog);
            var trusted = EnsureCurrentCertTrusted(store, currentCert, currentThumbprint, writeEventLog);

            if (removedCount == 0 && trusted)
            {
                Log.Info(() => "Certificate trust: no changes needed");
            }
        }
        catch (Exception ex)
        {
            var msg = $"CertificateTrust: Failed (non-admin?): {ex.Message}";
            Log.Warn(() => msg);
            writeEventLog?.Invoke(msg, false);
        }
    }

    private static int RemoveStaleCertificates(X509Store store, string currentThumbprint, Action<string, bool>? writeEventLog)
    {
        var toRemove = new List<X509Certificate2>();

        foreach (var cert in store.Certificates)
        {
            if (cert.Thumbprint == currentThumbprint)
            {
                continue;
            }

            var isCurrentSubject = cert.Subject == CertificateGenerator.CertificateSubject;
            var isLegacySubject = Array.Exists(LegacySubjects, s => cert.Subject == s);

            if (isCurrentSubject || isLegacySubject)
            {
                toRemove.Add(cert);
            }
        }

        foreach (var cert in toRemove)
        {
            var reason = cert.NotAfter < DateTime.Now ? "expired" : "stale";
            var msg = $"  Removing {reason} cert: {cert.Subject} {cert.Thumbprint[..8]}... (expires {cert.NotAfter:yyyy-MM-dd})";
            Log.Info(() => msg);
            writeEventLog?.Invoke($"CertificateTrust: {msg}", false);

            try
            {
                store.Remove(cert);
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"  Failed to remove cert {cert.Thumbprint[..8]}...: {ex.Message}");
            }
        }

        if (toRemove.Count > 0)
        {
            var summary = $"CertificateTrust: Removed {toRemove.Count} old certificate(s) from Root store";
            Log.Info(() => summary);
            writeEventLog?.Invoke(summary, false);
        }

        return toRemove.Count;
    }

    private static bool EnsureCurrentCertTrusted(X509Store store, X509Certificate2 currentCert, string currentThumbprint, Action<string, bool>? writeEventLog)
    {
        var found = false;
        foreach (var cert in store.Certificates)
        {
            if (cert.Thumbprint == currentThumbprint)
            {
                found = true;
                break;
            }
        }

        if (found)
        {
            return true;
        }

        Log.Info(() => $"Certificate trust: adding current cert to Root store ({currentThumbprint[..8]}...)");
        writeEventLog?.Invoke($"CertificateTrust: Adding current cert {currentThumbprint[..8]}... to Root store", false);

        try
        {
            store.Add(currentCert);
            Log.Info(() => "Certificate trust: current cert added to Root store");
            writeEventLog?.Invoke("CertificateTrust: Current cert added to Root store", false);
            return true;
        }
        catch (Exception ex)
        {
            var msg = $"CertificateTrust: Failed to add cert to Root store: {ex.Message}";
            Log.Warn(() => msg);
            writeEventLog?.Invoke(msg, false);
            return false;
        }
    }
}
