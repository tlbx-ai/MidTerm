using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class LensWebSocketProtocolTests
{
    [Fact]
    public void HistoryWindowRequest_RoundTripsViewportWidth()
    {
        var message = new LensWsRequestMessage
        {
            Id = "req-viewport",
            Action = "history.window.get",
            SessionId = "session-1",
            HistoryWindow = new LensHistoryWindowRequest
            {
                StartIndex = 12,
                Count = 48,
                ViewportWidth = 960,
                WindowRevision = "rev-viewport"
            }
        };

        var json = JsonSerializer.Serialize(message, LensHostJsonContext.Default.LensWsRequestMessage);
        var roundTrip = JsonSerializer.Deserialize(json, LensHostJsonContext.Default.LensWsRequestMessage);

        Assert.NotNull(roundTrip);
        Assert.Equal(960, roundTrip!.HistoryWindow?.ViewportWidth);
        Assert.Equal("rev-viewport", roundTrip.HistoryWindow?.WindowRevision);
    }

    [Fact]
    public void HistoryWindowMessage_RoundTripsWindowRevision()
    {
        var message = new LensWsHistoryWindowMessage
        {
            Id = "req-1",
            SessionId = "session-1",
            WindowRevision = "rev-42",
            HistoryWindow = new LensHistoryWindowResponse
            {
                SessionId = "session-1",
                Provider = "codex",
                GeneratedAt = DateTimeOffset.Parse(
                    "2026-04-13T10:00:00Z",
                    CultureInfo.InvariantCulture),
                LatestSequence = 12,
                HistoryCount = 40,
                HistoryWindowStart = 10,
                HistoryWindowEnd = 20,
                Session = new LensSessionSummary
                {
                    State = "ready",
                    StateLabel = "Ready"
                },
                Thread = new LensThreadSummary
                {
                    ThreadId = "thread-1",
                    State = "active",
                    StateLabel = "Active"
                },
                CurrentTurn = new LensTurnSummary
                {
                    State = "running",
                    StateLabel = "Running"
                }
            }
        };

        var json = JsonSerializer.Serialize(message, LensHostJsonContext.Default.LensWsHistoryWindowMessage);
        var roundTrip = JsonSerializer.Deserialize(json, LensHostJsonContext.Default.LensWsHistoryWindowMessage);

        Assert.NotNull(roundTrip);
        Assert.Equal("rev-42", roundTrip!.WindowRevision);
        Assert.Equal(12, roundTrip.HistoryWindow.LatestSequence);
    }
}
