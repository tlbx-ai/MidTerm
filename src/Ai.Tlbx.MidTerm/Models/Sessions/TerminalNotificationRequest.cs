using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class TerminalNotificationRequest
{
    public string? SessionId { get; init; }
    public string? Title { get; init; }

    [JsonRequired]
    public required string Body { get; init; }
}
