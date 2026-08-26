using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class TerminalNotificationRequest
{
    public string? SessionId { get; init; }
    public string? Title { get; init; }
    public NotificationPrioritySetting? Priority { get; init; }

    [JsonRequired]
    public required string Body { get; init; }
}
