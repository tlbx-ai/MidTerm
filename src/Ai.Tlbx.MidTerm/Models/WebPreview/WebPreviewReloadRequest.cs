namespace Ai.Tlbx.MidTerm.Models.WebPreview;

public sealed class WebPreviewReloadRequest
{
    public string? SessionId { get; init; }
    public string? PreviewName { get; init; }
    public string Mode { get; init; } = "soft";
}
