namespace Ai.Tlbx.MidTerm.Models.WebPreview;

public sealed class WebPreviewSessionInfo
{
    public string SessionId { get; init; } = "";
    public string PreviewName { get; init; } = "default";
    public string RouteKey { get; init; } = "";
    public string? Url { get; init; }
    public bool Active { get; init; }
    public long TargetRevision { get; init; }
}
