using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionAgentAttachPointDetectorTests
{
    [Fact]
    public void Detect_ReturnsCodexRemoteAttachPointAndResumeHint()
    {
        var attachPoint = SessionAgentAttachPointDetector.Detect(
            "codex",
            "\"C:\\Users\\johan\\AppData\\Roaming\\npm\\codex.cmd\" --remote ws://127.0.0.1:4513 resume thread-abc123");

        Assert.NotNull(attachPoint);
        Assert.Equal(SessionAgentAttachPoint.CodexProvider, attachPoint!.Provider);
        Assert.Equal(SessionAgentAttachPoint.CodexAppServerWebSocketTransport, attachPoint.TransportKind);
        Assert.Equal("ws://127.0.0.1:4513/", attachPoint.Endpoint);
        Assert.True(attachPoint.SharedRuntime);
        Assert.Equal("thread-abc123", attachPoint.PreferredThreadId);
    }

    [Fact]
    public void Detect_ReturnsCodexListenAttachPointForAppServerProcess()
    {
        var attachPoint = SessionAgentAttachPointDetector.Detect(
            "codex",
            "codex app-server --listen=wss://127.0.0.1:4514/custom");

        Assert.NotNull(attachPoint);
        Assert.Equal(SessionAgentAttachPoint.CodexAppServerWebSocketTransport, attachPoint!.TransportKind);
        Assert.Equal("wss://127.0.0.1:4514/custom", attachPoint.Endpoint);
        Assert.Null(attachPoint.PreferredThreadId);
    }

    [Fact]
    public void Detect_IgnoresNonCodexOrInvalidEndpoints()
    {
        Assert.Null(SessionAgentAttachPointDetector.Detect("pwsh", "pwsh -NoLogo"));
        Assert.Null(SessionAgentAttachPointDetector.Detect("codex", "codex --remote not-a-websocket-uri"));
    }
}
