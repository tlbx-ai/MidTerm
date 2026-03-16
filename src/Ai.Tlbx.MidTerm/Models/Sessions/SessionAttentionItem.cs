namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionAttentionItem
{
    public required SessionInfoDto Session { get; set; }
    public int AttentionScore { get; set; }
}
