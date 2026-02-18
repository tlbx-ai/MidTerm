using Ai.Tlbx.MidTerm.Models.System;

namespace Ai.Tlbx.MidTerm.Models.Certificates;

public sealed class SharePacketInfo
{
    public CertificateDownloadInfo Certificate { get; init; } = new();
    public NetworkEndpointInfo[] Endpoints { get; init; } = [];
    public string TrustPageUrl { get; init; } = "";
    public int Port { get; init; }
}
