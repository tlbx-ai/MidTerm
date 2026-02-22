namespace Ai.Tlbx.MidTerm.Models.WebPreview;

public sealed class WebPreviewSnapshotRequest
{
    public string SessionId { get; set; } = "";
    public string Html { get; set; } = "";
    public List<string> CssUrls { get; set; } = new();
}
