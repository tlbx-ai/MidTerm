using Ai.Tlbx.MidTerm.Models.WebPreview;
using Ai.Tlbx.MidTerm.Services.WebPreview;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class WebPreviewProxyLogSummaryTests
{
    [Fact]
    public void BuildProxyLogSummaryText_CompactsStatusFailuresAndWebSockets()
    {
        var entries = new List<WebPreviewProxyLogEntry>
        {
            new()
            {
                Type = "http",
                Method = "GET",
                UpstreamUrl = "https://example.com/",
                StatusCode = 200,
                DurationMs = 12
            },
            new()
            {
                Type = "http",
                Method = "GET",
                UpstreamUrl = "https://example.com/missing.js",
                StatusCode = 404,
                DurationMs = 34
            },
            new()
            {
                Type = "ws",
                Method = "WS-UPGRADE",
                UpstreamUrl = "wss://example.com/ws",
                StatusCode = 502,
                Error = "upstream rejected",
                DurationMs = 55
            }
        };

        var summary = WebPreviewEndpoints.BuildProxyLogSummaryText(entries);

        Assert.Contains("entries: 3", summary, StringComparison.Ordinal);
        Assert.Contains("status: 200:1 404:1 502:1", summary, StringComparison.Ordinal);
        Assert.Contains("websocket: 1 total, 0 connected, 1 failed", summary, StringComparison.Ordinal);
        Assert.Contains("failures:", summary, StringComparison.Ordinal);
        Assert.Contains("missing.js", summary, StringComparison.Ordinal);
        Assert.Contains("upstream rejected", summary, StringComparison.Ordinal);
    }
}
