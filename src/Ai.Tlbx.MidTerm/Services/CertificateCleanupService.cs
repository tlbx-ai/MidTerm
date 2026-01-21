using System.Security.Cryptography.X509Certificates;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Cleans up old MidTerm certificates from the trusted Root store on Windows.
/// Runs on startup to remove stale certificates that may have been orphaned
/// during updates or certificate regeneration.
/// </summary>
public static class CertificateCleanupService
{
    public static void CleanupOldCertificates(X509Certificate2 currentCert, Action<string, bool>? writeEventLog = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var currentThumbprint = currentCert.Thumbprint;
        Log.Info(() => $"Certificate cleanup: keeping thumbprint {currentThumbprint[..8]}...");
        writeEventLog?.Invoke($"CertificateCleanup: Current cert thumbprint={currentThumbprint[..8]}...", false);

        try
        {
            using var store = new X509Store(StoreName.Root, StoreLocation.LocalMachine);
            store.Open(OpenFlags.ReadWrite);

            var toRemove = new List<X509Certificate2>();
            foreach (var cert in store.Certificates)
            {
                if (cert.Subject == CertificateGenerator.CertificateSubject &&
                    cert.Thumbprint != currentThumbprint)
                {
                    toRemove.Add(cert);
                }
            }

            foreach (var cert in toRemove)
            {
                var reason = cert.NotAfter < DateTime.Now ? "expired" : "stale";
                var msg = $"  Removing {reason} cert: {cert.Thumbprint[..8]}... (expires {cert.NotAfter:yyyy-MM-dd})";
                Log.Info(() => msg);
                writeEventLog?.Invoke($"CertificateCleanup: {msg}", false);

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
                var summary = $"CertificateCleanup: Removed {toRemove.Count} old certificate(s) from Root store";
                Log.Info(() => summary);
                writeEventLog?.Invoke(summary, false);
            }
        }
        catch (Exception ex)
        {
            var msg = $"CertificateCleanup: Failed (non-admin?): {ex.Message}";
            Log.Warn(() => msg);
            writeEventLog?.Invoke(msg, false);
        }
    }
}
