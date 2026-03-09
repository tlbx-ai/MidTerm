namespace Ai.Tlbx.MidTerm.Models.Browser;

public sealed class BrowserPreviewClientResponse
{
    public string? SessionId { get; init; }
    public string PreviewId { get; init; } = "";
    public string PreviewToken { get; init; } = "";
}
