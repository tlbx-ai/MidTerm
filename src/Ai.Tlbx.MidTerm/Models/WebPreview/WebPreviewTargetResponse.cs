namespace Ai.Tlbx.MidTerm.Models.WebPreview;

public sealed class WebPreviewTargetResponse
{
    public string? SessionId { get; set; }
    public string PreviewName { get; set; } = "default";
    public string? RouteKey { get; set; }
    public string? Url { get; set; }
    public bool Active { get; set; }
}
