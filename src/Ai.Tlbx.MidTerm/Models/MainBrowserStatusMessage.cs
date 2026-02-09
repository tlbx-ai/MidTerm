namespace Ai.Tlbx.MidTerm.Models;

public sealed class MainBrowserStatusMessage
{
    public string Type { get; set; } = "main-browser-status";
    public bool IsMain { get; set; }
}
