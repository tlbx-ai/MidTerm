namespace Ai.Tlbx.MidTerm.Models.Certificates;

public sealed class CertificateDownloadInfo
{
    public string Fingerprint { get; init; } = "";
    public string FingerprintFormatted { get; init; } = "";
    public DateTime NotBefore { get; init; }
    public DateTime NotAfter { get; init; }
    public string KeyProtection { get; init; } = "";
    public string[] DnsNames { get; init; } = [];
    public string[] IpAddresses { get; init; } = [];
    public bool IsFallbackCertificate { get; init; }
}
