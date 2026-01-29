using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Update;

/// <summary>
/// Specifies the type of update available.
/// </summary>
public enum UpdateType
{
    /// <summary>No update available.</summary>
    [JsonStringEnumMemberName("none")] None,
    /// <summary>Web server update only; terminal sessions are preserved.</summary>
    [JsonStringEnumMemberName("webOnly")] WebOnly,
    /// <summary>Full update including PTY host; terminal sessions will restart.</summary>
    [JsonStringEnumMemberName("full")] Full
}
