namespace Ai.Tlbx.MidTerm.Models.Browser;

public sealed class BrowserUiInstruction
{
    public string Type { get; set; } = "browser-ui";
    public string Command { get; set; } = "";
    public int? Width { get; set; }
    public int? Height { get; set; }
    public string? Url { get; set; }
    public string? SessionId { get; set; }
    public string? PreviewName { get; set; }
    public bool? ActivateSession { get; set; }
}

public sealed class ViewportRequest
{
    public int Width { get; init; }
    public int Height { get; init; }
    public string? SessionId { get; init; }
    public string? PreviewName { get; init; }
}
