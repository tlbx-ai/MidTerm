namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionKeyInputRequest
{
    public List<string> Keys { get; set; } = [];
    public bool Literal { get; set; }
}
