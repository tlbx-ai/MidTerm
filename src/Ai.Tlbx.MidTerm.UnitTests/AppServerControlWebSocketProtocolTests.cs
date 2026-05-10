using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class AppServerControlWebSocketProtocolTests
{
    [Fact]
    public void HistoryWindowRequest_RoundTripsViewportWidth()
    {
        var message = new AppServerControlWsRequestMessage
        {
            Id = "req-viewport",
            Action = "history.window.get",
            SessionId = "session-1",
            HistoryWindow = new AppServerControlHistoryWindowRequest
            {
                StartIndex = 12,
                Count = 48,
                ViewportWidth = 960,
                WindowRevision = "rev-viewport"
            }
        };

        var json = JsonSerializer.Serialize(message, AppServerControlHostJsonContext.Default.AppServerControlWsRequestMessage);
        var roundTrip = JsonSerializer.Deserialize(json, AppServerControlHostJsonContext.Default.AppServerControlWsRequestMessage);

        Assert.NotNull(roundTrip);
        Assert.Equal(960, roundTrip!.HistoryWindow?.ViewportWidth);
        Assert.Equal("rev-viewport", roundTrip.HistoryWindow?.WindowRevision);
    }

    [Fact]
    public void HistoryWindowMessage_RoundTripsWindowRevision()
    {
        var message = new AppServerControlWsHistoryWindowMessage
        {
            Id = "req-1",
            SessionId = "session-1",
            WindowRevision = "rev-42",
            HistoryWindow = new AppServerControlHistoryWindowResponse
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
                Session = new AppServerControlSessionSummary
                {
                    State = "ready",
                    StateLabel = "Ready"
                },
                Thread = new AppServerControlThreadSummary
                {
                    ThreadId = "thread-1",
                    State = "active",
                    StateLabel = "Active"
                },
                CurrentTurn = new AppServerControlTurnSummary
                {
                    State = "running",
                    StateLabel = "Running"
                }
            }
        };

        var json = JsonSerializer.Serialize(message, AppServerControlHostJsonContext.Default.AppServerControlWsHistoryWindowMessage);
        var roundTrip = JsonSerializer.Deserialize(json, AppServerControlHostJsonContext.Default.AppServerControlWsHistoryWindowMessage);

        Assert.NotNull(roundTrip);
        Assert.Equal("rev-42", roundTrip!.WindowRevision);
        Assert.Equal(12, roundTrip.HistoryWindow.LatestSequence);
    }
}
