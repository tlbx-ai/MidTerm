namespace Ai.Tlbx.MidTerm.Models.Browser;

public sealed class BrowserWsMessage
{
    public string Id { get; init; } = "";
    public string Command { get; init; } = "";
    public string? Selector { get; init; }
    public string? Value { get; init; }
    public int? MaxDepth { get; init; }
    public bool TextOnly { get; init; }
    public int? Timeout { get; init; }
    public string? SessionId { get; init; }
    public string? PreviewId { get; init; }
}
