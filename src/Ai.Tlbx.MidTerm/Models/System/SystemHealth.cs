namespace Ai.Tlbx.MidTerm.Models.System;

/// <summary>
/// System health information returned by the health endpoint.
/// </summary>
public sealed class SystemHealth
{
    public bool Healthy { get; init; }
    public string Mode { get; init; } = "";
    public int SessionCount { get; init; }
    public string Version { get; init; } = "";
    public int WebProcessId { get; init; }
    public long UptimeSeconds { get; init; }
    public string Platform { get; init; } = "";
    public string? TtyHostVersion { get; init; }
    public string? TtyHostExpected { get; init; }
    public bool? TtyHostCompatible { get; init; }
    public int? WindowsBuildNumber { get; init; }
}
