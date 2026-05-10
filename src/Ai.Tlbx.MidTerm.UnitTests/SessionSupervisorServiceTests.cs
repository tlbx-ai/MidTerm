using System.Text;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionSupervisorServiceTests
{
    [Fact]
    public void Describe_ReturnsShellStateForShellForeground()
    {
        var service = CreateService();
        var session = new SessionInfoDto
        {
            Id = "shell1",
            IsRunning = true,
            ShellType = "pwsh",
            ForegroundName = "pwsh"
        };

        var result = service.Describe(session);

        Assert.Equal(SessionSupervisorService.ShellState, result.State);
        Assert.Equal(AiCliProfileService.ShellProfile, result.Profile);
        Assert.False(result.NeedsAttention);
    }

    [Fact]
    public void Describe_ReturnsBusyTurnForRecentCodexOutput()
    {
        var telemetry = new SessionTelemetryService();
        telemetry.RecordOutput("busy1", Encoding.UTF8.GetBytes("thinking..."));
        var service = CreateService(telemetry: telemetry);
        var session = new SessionInfoDto
        {
            Id = "busy1",
            IsRunning = true,
            ShellType = "pwsh",
            ForegroundName = "codex"
        };

        var result = service.Describe(session);

        Assert.Equal(SessionSupervisorService.BusyTurnState, result.State);
        Assert.Equal(AiCliProfileService.CodexProfile, result.Profile);
    }

    [Fact]
    public void Describe_ReturnsBlockedWhenPromptWasSentButNoOutputFollowed()
    {
        var telemetry = new SessionTelemetryService();
        telemetry.RecordInput("blocked1", 42);
        var service = CreateService(telemetry: telemetry);
        var session = new SessionInfoDto
        {
            Id = "blocked1",
            IsRunning = true,
            AgentControlled = true,
            ShellType = "pwsh",
            ForegroundName = "claude"
        };

        var result = service.Describe(session);

        Assert.Equal(SessionSupervisorService.BlockedState, result.State);
        Assert.True(result.NeedsAttention);
        Assert.Equal("prompt-not-acknowledged", result.AttentionReason);
    }

    [Fact]
    public void DescribeFleet_SortsAttentionSessionsFirst()
    {
        var telemetry = new SessionTelemetryService();
        telemetry.RecordInput("blocked1", 5);
        telemetry.RecordOutput("busy1", Encoding.UTF8.GetBytes("working"));

        var service = CreateService(telemetry: telemetry);
        var sessions = new[]
        {
            new SessionInfoDto
            {
                Id = "busy1",
                IsRunning = true,
                AgentControlled = true,
                ShellType = "pwsh",
                ForegroundName = "codex",
                Order = 2
            },
            new SessionInfoDto
            {
                Id = "blocked1",
                IsRunning = true,
                AgentControlled = true,
                ShellType = "pwsh",
                ForegroundName = "claude",
                Order = 1
            }
        };

        var result = service.DescribeFleet(sessions, agentOnly: true);

        Assert.Equal(1, result.AttentionCount);
        Assert.Equal(["blocked1", "busy1"], result.Sessions.Select(item => item.Session.Id).ToArray());
    }

    [Fact]
    public void Describe_ReturnsBusyTurnForRunningAppServerControlTurnWithoutTerminalBytes()
    {
        var service = CreateService(
            appServerControlHeatSource: new FakeAppServerControlHeatSource(new SessionAppServerControlHeatSnapshot
            {
                CurrentHeat = 1,
                LastActivityAt = DateTimeOffset.UtcNow.AddSeconds(-30)
            }));
        var session = new SessionInfoDto
        {
            Id = "appServerControl1",
            IsRunning = true,
            ShellType = "pwsh",
            ForegroundName = "codex"
        };

        var result = service.Describe(session);

        Assert.Equal(SessionSupervisorService.BusyTurnState, result.State);
        Assert.Equal(1, result.CurrentHeat);
        Assert.NotNull(result.LastOutputAt);
    }

    private static SessionSupervisorService CreateService(
        SessionTelemetryService? telemetry = null,
        ISessionAppServerControlHeatSource? appServerControlHeatSource = null)
    {
        var heatService = new SessionHeatService(
            telemetry ?? new SessionTelemetryService(),
            appServerControlHeatSource ?? new FakeAppServerControlHeatSource(SessionAppServerControlHeatSnapshot.Cold));

        return new SessionSupervisorService(
            heatService,
            new AiCliProfileService());
    }

    private sealed class FakeAppServerControlHeatSource(SessionAppServerControlHeatSnapshot snapshot) : ISessionAppServerControlHeatSource
    {
        public SessionAppServerControlHeatSnapshot GetHeatSnapshot(string sessionId) => snapshot;
    }
}


