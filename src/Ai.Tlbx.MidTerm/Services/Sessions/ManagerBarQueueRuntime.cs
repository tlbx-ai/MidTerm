using System.Text;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public interface IManagerBarQueueRuntime
{
    IReadOnlyCollection<string> GetActiveSessionIds();
    bool SessionExists(string sessionId);
    double GetCurrentHeat(string sessionId);
    Task SendPromptAsync(string sessionId, string prompt, CancellationToken cancellationToken);
}

public sealed class ManagerBarQueueRuntime : IManagerBarQueueRuntime
{
    private const int SessionTextSubmitDelayMs = 200;

    private readonly TtyHostSessionManager _sessionManager;
    private readonly SessionHeatService _sessionHeat;
    private readonly SessionTelemetryService _sessionTelemetry;
    private readonly SessionLensRuntimeService _lensRuntime;

    public ManagerBarQueueRuntime(
        TtyHostSessionManager sessionManager,
        SessionHeatService sessionHeat,
        SessionTelemetryService sessionTelemetry,
        SessionLensRuntimeService lensRuntime)
    {
        _sessionManager = sessionManager;
        _sessionHeat = sessionHeat;
        _sessionTelemetry = sessionTelemetry;
        _lensRuntime = lensRuntime;
    }

    public IReadOnlyCollection<string> GetActiveSessionIds()
    {
        return _sessionManager.GetAllSessions()
            .Select(static session => session.Id)
            .ToArray();
    }

    public bool SessionExists(string sessionId)
    {
        return _sessionManager.GetSession(sessionId) is not null;
    }

    public double GetCurrentHeat(string sessionId)
    {
        return _sessionHeat.GetSnapshot(sessionId).CurrentHeat;
    }

    public async Task SendPromptAsync(string sessionId, string prompt, CancellationToken cancellationToken)
    {
        var session = _sessionManager.GetSession(sessionId);
        if (session is null)
        {
            return;
        }

        var lensOnly = _sessionManager.GetSessionList().Sessions
            .FirstOrDefault(candidate => string.Equals(candidate.Id, sessionId, StringComparison.Ordinal))
            ?.LensOnly == true;

        if (lensOnly)
        {
            var sent = await _lensRuntime.TrySendPromptAsync(
                sessionId,
                new SessionPromptRequest { Text = prompt },
                cancellationToken).ConfigureAwait(false);
            if (sent)
            {
                return;
            }
        }

        var promptBytes = Encoding.UTF8.GetBytes(prompt);
        _sessionTelemetry.RecordInput(sessionId, promptBytes.Length);
        await _sessionManager.SendInputAsync(sessionId, promptBytes, cancellationToken).ConfigureAwait(false);

        await Task.Delay(SessionTextSubmitDelayMs, cancellationToken).ConfigureAwait(false);

        var submitBytes = new byte[] { (byte)'\r' };
        _sessionTelemetry.RecordInput(sessionId, submitBytes.Length);
        await _sessionManager.SendInputAsync(sessionId, submitBytes, cancellationToken).ConfigureAwait(false);
    }
}
