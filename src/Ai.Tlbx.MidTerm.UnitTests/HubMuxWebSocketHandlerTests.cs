using Ai.Tlbx.MidTerm.Services.Hub;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class HubMuxWebSocketHandlerTests
{
    [Fact]
    public void BuildRemoteMuxUri_ScopesReplayAndLiveOutputToSelectedSession()
    {
        var uri = HubMuxWebSocketHandler.BuildRemoteMuxUri(
            "https://remote.example:2443/base",
            "sess1234",
            987654321UL);

        Assert.Equal("wss", uri.Scheme);
        Assert.Equal("/ws/mux", uri.AbsolutePath);
        Assert.Contains("activeSessionId=sess1234", uri.Query, StringComparison.Ordinal);
        Assert.Contains("visibleSessionIds=sess1234", uri.Query, StringComparison.Ordinal);
        Assert.Contains("resumeCursors=sess1234%3A987654321", uri.Query, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildRemoteMuxUri_OmitsResumeCursorUntilBrowserHasRenderedOutput()
    {
        var uri = HubMuxWebSocketHandler.BuildRemoteMuxUri(
            "http://remote.example:2000",
            "sess1234",
            null);

        Assert.Equal("ws", uri.Scheme);
        Assert.DoesNotContain("resumeCursors", uri.Query, StringComparison.Ordinal);
    }
}
