namespace Ai.Tlbx.MidTerm.Models.WebPreview;

public sealed class WebPreviewCookieInfo
{
    public string Name { get; set; } = "";
    public string Value { get; set; } = "";
    public string Domain { get; set; } = "";
    public string Path { get; set; } = "";
    public bool Secure { get; set; }
    public bool HttpOnly { get; set; }
    public DateTimeOffset? ExpiresUtc { get; set; }
    public string? SameSite { get; set; }
}
