using System.Globalization;
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
        var service = new SessionHeatService(
            new SessionTelemetryService(),
            new FakeLensHeatSource(new SessionLensHeatSnapshot
            {
                CurrentHeat = 1,
                LastActivityAt = now.AddMinutes(-2)
            }),
            timeProvider);

        var snapshot = service.GetSnapshot("lens-hot");

        Assert.Equal(1, snapshot.CurrentHeat);
        Assert.Equal(now, snapshot.LastOutputAt);
    }

    [Fact]
    public void GetSnapshot_DoesNotHeatWhileLensWaitsForUserInput()
    {
        var now = DateTimeOffset.Parse("2026-04-05T09:00:00Z", CultureInfo.InvariantCulture);
        var service = new SessionHeatService(
            new SessionTelemetryService(),
            new FakeLensHeatSource(SessionLensHeatSnapshot.Cold),
            new FakeTimeProvider(now));

        var snapshot = service.GetSnapshot("lens-waiting");

        Assert.Equal(0, snapshot.CurrentHeat);
        Assert.Null(snapshot.LastOutputAt);
    }

    [Fact]
    public void GetSnapshot_PreservesTerminalHeatWhenLensIsCold()
    {
        var telemetry = new SessionTelemetryService();
        telemetry.RecordOutput("terminal-hot", System.Text.Encoding.UTF8.GetBytes("output"));
        var service = new SessionHeatService(telemetry, new FakeLensHeatSource(SessionLensHeatSnapshot.Cold));

        var snapshot = service.GetSnapshot("terminal-hot");

        Assert.Equal(1, snapshot.CurrentHeat);
        Assert.NotNull(snapshot.LastOutputAt);
    }

    private sealed class FakeLensHeatSource(SessionLensHeatSnapshot snapshot) : ISessionLensHeatSource
    {
        public SessionLensHeatSnapshot GetHeatSnapshot(string sessionId) => snapshot;
    }
}



