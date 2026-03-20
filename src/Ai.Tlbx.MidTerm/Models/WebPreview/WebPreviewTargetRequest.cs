namespace Ai.Tlbx.MidTerm.Models.WebPreview;

public sealed class WebPreviewTargetRequest
{
    public string? SessionId { get; init; }
    public string? PreviewName { get; init; }
    public string Url { get; init; } = "";
    public bool? ActivateSession { get; init; }
}
