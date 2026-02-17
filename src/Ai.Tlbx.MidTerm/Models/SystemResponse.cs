using Ai.Tlbx.MidTerm.Models.Update;

namespace Ai.Tlbx.MidTerm.Models;

/// <summary>
/// Consolidated system info from GET /api/system.
/// Combines health, version, and version manifest data.
/// </summary>
public sealed class SystemResponse
{
    /// <summary>
    /// Whether the system is healthy
    /// </summary>
    public bool Healthy { get; init; }

    /// <summary>
    /// Server version string
    /// </summary>
    public string Version { get; init; } = "";

    /// <summary>
    /// Version manifest with detailed version info
    /// </summary>
    public VersionManifest Manifest { get; init; } = new();

    /// <summary>
    /// Number of active terminal sessions
    /// </summary>
    public int SessionCount { get; init; }

    /// <summary>
    /// Server uptime in seconds
    /// </summary>
    public long UptimeSeconds { get; init; }

    /// <summary>
    /// Platform identifier (Windows, macOS, Linux)
    /// </summary>
    public string Platform { get; init; } = "";

    /// <summary>
    /// TtyHost version info
    /// </summary>
    public TtyHostInfo TtyHost { get; init; } = new();

    /// <summary>
    /// Web server process ID
    /// </summary>
    public int WebProcessId { get; init; }

    /// <summary>
    /// Windows build number (Windows only)
    /// </summary>
    public int? WindowsBuildNumber { get; init; }
}

/// <summary>
/// TtyHost version info nested in SystemResponse.
/// </summary>
public sealed class TtyHostInfo
{
    /// <summary>
    /// Actual TtyHost version (null if not detected)
    /// </summary>
    public string? Version { get; init; }

    /// <summary>
    /// Expected TtyHost version from manifest
    /// </summary>
    public string? Expected { get; init; }

    /// <summary>
    /// Whether TtyHost is compatible with the server
    /// </summary>
    public bool Compatible { get; init; }
}

/// <summary>
/// Request payload for PATCH /api/history/{id}
/// </summary>
public sealed class HistoryPatchRequest
{
    /// <summary>
    /// Set star status (true = starred, false = not starred)
    /// </summary>
    public bool? IsStarred { get; init; }

    /// <summary>
    /// Set label (null = not provided, "" = clear, "text" = set)
    /// </summary>
    public string? Label { get; init; }
}
