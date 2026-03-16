namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionPromptRequest
{
    public string? Text { get; set; }
    public string? Base64 { get; set; }
    public bool InterruptFirst { get; set; }
    public List<string> InterruptKeys { get; set; } = ["C-c"];
    public bool LiteralInterruptKeys { get; set; }
    public int InterruptDelayMs { get; set; } = 150;
    public List<string> SubmitKeys { get; set; } = ["Enter"];
    public bool LiteralSubmitKeys { get; set; }
    public int SubmitDelayMs { get; set; } = 300;
}
