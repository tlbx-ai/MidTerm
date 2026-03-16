namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionAttentionResponse
{
    public DateTimeOffset GeneratedAt { get; set; } = DateTimeOffset.UtcNow;
    public bool AgentOnly { get; set; } = true;
    public int AttentionCount { get; set; }
    public List<SessionAttentionItem> Sessions { get; set; } = [];
}
