namespace Ai.Tlbx.MidTerm.Models.Browser;

public sealed class BrowserStatusResponse
{
    public bool Connected { get; init; }
    public int ConnectedClientCount { get; init; }
    public int ConnectedUiClientCount { get; init; }
    public string? TargetUrl { get; init; }
    public BrowserClientInfo? DefaultClient { get; init; }
    public BrowserClientInfo[] Clients { get; init; } = [];
}

public sealed class BrowserClientInfo
{
    public string? SessionId { get; init; }
    public string? PreviewName { get; init; }
    public string? PreviewId { get; init; }
    public string? BrowserId { get; init; }
    public DateTimeOffset ConnectedAtUtc { get; init; }
    public bool IsMainBrowser { get; init; }
}
