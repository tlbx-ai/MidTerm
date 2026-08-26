using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

/// <summary>
/// A live terminal notification extracted from the PTY output stream.
/// This message is intentionally transient and is never included in state snapshots.
/// </summary>
public sealed class TerminalNotificationMessage
{
    public string Type { get; init; } = "terminal-notification";
    public required string SessionId { get; init; }
    public required string Protocol { get; init; }
    public string? Title { get; init; }
    public string? Body { get; init; }
    public bool Force { get; init; }
    public NotificationPrioritySetting? Priority { get; init; }
    public bool NativeHandled { get; init; }
}
