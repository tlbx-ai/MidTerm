namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionInputRequest
{
    public string? Text { get; set; }
    public string? Base64 { get; set; }
    public bool AppendNewline { get; set; }
}
