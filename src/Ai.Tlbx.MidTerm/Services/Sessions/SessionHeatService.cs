namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionHeatService
{
    private readonly SessionTelemetryService _telemetryService;
    private readonly ISessionLensHeatSource _lensHeatSource;
    private readonly TimeProvider _timeProvider;

    public SessionHeatService(
        SessionTelemetryService telemetryService,
        ISessionLensHeatSource lensHeatSource,
        TimeProvider? timeProvider = null)
    {
        _telemetryService = telemetryService;
        _lensHeatSource = lensHeatSource;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public SessionHeatSnapshot GetSnapshot(string sessionId)
    {
        var telemetry = _telemetryService.GetSnapshot(sessionId);
        var lensHeat = _lensHeatSource.GetHeatSnapshot(sessionId);
        var currentHeat = Math.Max(telemetry.CurrentHeat, lensHeat.CurrentHeat);
        var lastOutputAt = telemetry.LastOutputAt;
        if (lensHeat.CurrentHeat > 0)
        {
            lastOutputAt = _timeProvider.GetUtcNow();
        }

        return new SessionHeatSnapshot
        {
            TotalOutputBytes = telemetry.TotalOutputBytes,
            TotalInputBytes = telemetry.TotalInputBytes,
            TotalBellCount = telemetry.TotalBellCount,
            LastInputAt = telemetry.LastInputAt,
            LastOutputAt = lastOutputAt,
            LastBellAt = telemetry.LastBellAt,
            CurrentBytesPerSecond = telemetry.CurrentBytesPerSecond,
            CurrentHeat = currentHeat
        };
    }
}
