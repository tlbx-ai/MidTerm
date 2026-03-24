using Ai.Tlbx.MidTerm.Models.WebPreview;

namespace Ai.Tlbx.MidTerm.Models.Sessions;

public sealed class SessionStateResponse
{
    public required SessionInfoDto Session { get; set; }
    public WebPreviewSessionInfo[] Previews { get; set; } = [];
    public int BufferByteLength { get; set; }
    public string BufferEncoding { get; set; } = "utf-8";
    public string? BufferText { get; set; }
    public string? BufferBase64 { get; set; }
    public TerminalTransportDiagnosticsDto? TerminalTransport { get; set; }
    public SessionSupervisorInfoDto? Supervisor => Session.Supervisor;
}
