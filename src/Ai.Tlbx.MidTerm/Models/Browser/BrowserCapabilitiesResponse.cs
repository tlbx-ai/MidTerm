namespace Ai.Tlbx.MidTerm.Models.Browser;

public sealed class BrowserCapabilitiesResponse
{
    public string SessionId { get; init; } = "";
    public string PreviewName { get; init; } = "";
    public BrowserStatusResponse Status { get; init; } = new();
    public string[] FastCommands { get; init; } = [];
    public string[] DiagnosticCommands { get; init; } = [];
    public string[] RecoveryCommands { get; init; } = [];
    public string[] Notes { get; init; } = [];
}
