namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionBufferTextResponse
{
    public string SessionId { get; set; } = "";
    public int ByteLength { get; set; }
    public string Encoding { get; set; } = "utf-8";
    public string Text { get; set; } = "";
    public string? Base64 { get; set; }
}
