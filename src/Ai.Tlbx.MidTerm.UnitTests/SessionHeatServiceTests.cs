using System.Globalization;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionHeatServiceTests
{
    [Fact]
    public void GetSnapshot_ReportsHeatForRunningLensTurn()
    {
        var now = DateTimeOffset.Parse("2026-04-05T09:00:00Z", CultureInfo.InvariantCulture);
        var timeProvider = new FakeTimeProvider(now);
        var pulse = new SessionLensPulseService();
        pulse.Append(new LensPulseEvent
        {
            EventId = "turn-1",
            SessionId = "lens-hot",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = now.AddMinutes(-2),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload
            {
                Model = "gpt-5.4",
                Effort = "high"
            }
        });

        var service = new SessionHeatService(new SessionTelemetryService(), pulse, timeProvider);

        var snapshot = service.GetSnapshot("lens-hot");

        Assert.Equal(1, snapshot.CurrentHeat);
        Assert.Equal(now, snapshot.LastOutputAt);
    }

    [Fact]
    public void GetSnapshot_DoesNotHeatWhileLensWaitsForUserInput()
    {
        var now = DateTimeOffset.Parse("2026-04-05T09:00:00Z", CultureInfo.InvariantCulture);
        var pulse = new SessionLensPulseService();
        pulse.Append(new LensPulseEvent
        {
            EventId = "turn-1",
            SessionId = "lens-waiting",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = now.AddSeconds(-10),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload()
        });
        pulse.Append(new LensPulseEvent
        {
            EventId = "request-1",
            SessionId = "lens-waiting",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            RequestId = "req-1",
            CreatedAt = now.AddSeconds(-5),
            Type = "request.opened",
            RequestOpened = new LensPulseRequestOpenedPayload
            {
                RequestType = "command_execution_approval",
                RequestTypeLabel = "Command approval",
                Detail = "run tests"
            }
        });

        var service = new SessionHeatService(new SessionTelemetryService(), pulse, new FakeTimeProvider(now));

        var snapshot = service.GetSnapshot("lens-waiting");

        Assert.Equal(0, snapshot.CurrentHeat);
        Assert.Null(snapshot.LastOutputAt);
    }

    [Fact]
    public void GetSnapshot_PreservesTerminalHeatWhenLensIsCold()
    {
        var telemetry = new SessionTelemetryService();
        telemetry.RecordOutput("terminal-hot", Encoding.UTF8.GetBytes("output"));
        var service = new SessionHeatService(telemetry, new SessionLensPulseService());

        var snapshot = service.GetSnapshot("terminal-hot");

        Assert.Equal(1, snapshot.CurrentHeat);
        Assert.NotNull(snapshot.LastOutputAt);
    }
}
