namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class ProviderResumeCatalogEntryDto
{
    public string Provider { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string WorkingDirectory { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? PreviewText { get; set; }
    public DateTime UpdatedAtUtc { get; set; }
}
