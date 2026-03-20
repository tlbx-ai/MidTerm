namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class AgentSessionFeedResponse
{
    public string SessionId { get; set; } = string.Empty;
    public string Source { get; set; } = "fallback";
    public DateTimeOffset GeneratedAt { get; set; }
    public List<AgentSessionVibeActivity> Activities { get; set; } = [];
}
