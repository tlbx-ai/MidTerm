using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models;

/// <summary>
/// Consolidated startup data returned by GET /api/bootstrap.
/// Combines auth status, version, health, settings, networks, users, and update result
/// into a single response to reduce HTTP round-trips on page load.
/// </summary>
public sealed class BootstrapResponse
{
    /// <summary>
    /// Authentication status (replaces /api/auth/status)
    /// </summary>
    public AuthStatusResponse Auth { get; init; } = new();

    /// <summary>
    /// Server version string (replaces /api/version)
    /// </summary>
    public string Version { get; init; } = "";

    /// <summary>
    /// TtyHost version, or null if not detected
    /// </summary>
    public string? TtyHostVersion { get; init; }

    /// <summary>
    /// Whether TtyHost is compatible with the server
    /// </summary>
    public bool TtyHostCompatible { get; init; }

    /// <summary>
    /// Server uptime in seconds
    /// </summary>
    public long UptimeSeconds { get; init; }

    /// <summary>
    /// Platform identifier (Windows, macOS, Linux)
    /// </summary>
    public string Platform { get; init; } = "";

    /// <summary>
    /// Machine hostname for tab title display
    /// </summary>
    public string Hostname { get; init; } = "";

    /// <summary>
    /// Public settings (replaces /api/settings)
    /// </summary>
    public MidTermSettingsPublic Settings { get; init; } = new();

    /// <summary>
    /// Available network interfaces (replaces /api/networks)
    /// </summary>
    public List<NetworkInterfaceDto> Networks { get; init; } = [];

    /// <summary>
    /// System users for run-as dropdown (replaces /api/users)
    /// </summary>
    public List<UserInfo> Users { get; init; } = [];

    /// <summary>
    /// Available shells for the platform (replaces /api/shells)
    /// </summary>
    public List<ShellInfoDto> Shells { get; init; } = [];

    /// <summary>
    /// Update result from previous update (auto-cleared after read).
    /// Null if no update result exists.
    /// </summary>
    public UpdateResult? UpdateResult { get; init; }

    /// <summary>
    /// Whether server is running in development mode
    /// </summary>
    public bool DevMode { get; init; }

    /// <summary>
    /// Feature flags for conditional UI features
    /// </summary>
    public FeatureFlags Features { get; init; } = new();

    /// <summary>
    /// Voice server password (only included in dev mode).
    /// Browser appends this to WebSocket URL for MidTerm.Voice authentication.
    /// </summary>
    public string? VoicePassword { get; init; }
}

/// <summary>
/// Minimal bootstrap data for login page (GET /api/bootstrap/login).
/// Only includes certificate info needed for TOFU display.
/// </summary>
public sealed class BootstrapLoginResponse
{
    /// <summary>
    /// Certificate info for TOFU display
    /// </summary>
    public CertificateInfoResponse? Certificate { get; init; }
}
