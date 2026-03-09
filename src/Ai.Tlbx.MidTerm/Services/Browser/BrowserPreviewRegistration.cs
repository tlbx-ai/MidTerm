namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserPreviewRegistration
{
    public string? SessionId { get; init; }
    public string PreviewId { get; init; } = "";
    public string PreviewToken { get; init; } = "";
    public string? BrowserId { get; init; }
}
