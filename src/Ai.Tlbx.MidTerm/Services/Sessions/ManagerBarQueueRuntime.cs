using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public interface IManagerBarQueueRuntime
{
    IReadOnlyCollection<string> GetActiveSessionIds();
    bool SessionExists(string sessionId);
    double GetCurrentHeat(string sessionId);
    bool UsesTurnQueue(string sessionId);
    bool IsTurnQueueReady(string sessionId);
    Task SendPromptAsync(string sessionId, string prompt, CancellationToken cancellationToken);
    Task SendTurnAsync(string sessionId, LensTurnRequest request, CancellationToken cancellationToken);
}

public sealed class ManagerBarQueueRuntime : IManagerBarQueueRuntime
{
    private const int SessionTextSubmitDelayMs = 200;

    private readonly TtyHostSessionManager _sessionManager;
    private readonly SessionHeatService _sessionHeat;
    private readonly SessionTelemetryService _sessionTelemetry;
    private readonly SessionLensPulseService _lensPulse;
    private readonly SessionLensRuntimeService _lensRuntime;

    public ManagerBarQueueRuntime(
        TtyHostSessionManager sessionManager,
        SessionHeatService sessionHeat,
        SessionTelemetryService sessionTelemetry,
        SessionLensPulseService lensPulse,
        SessionLensRuntimeService lensRuntime)
    {
        _sessionManager = sessionManager;
        _sessionHeat = sessionHeat;
        _sessionTelemetry = sessionTelemetry;
        _lensPulse = lensPulse;
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

    public bool UsesTurnQueue(string sessionId)
    {
        return _sessionManager.GetSessionList().Sessions
            .FirstOrDefault(candidate => string.Equals(candidate.Id, sessionId, StringComparison.Ordinal))
            ?.LensOnly == true;
    }

    public bool IsTurnQueueReady(string sessionId)
    {
        if (!UsesTurnQueue(sessionId))
        {
            return false;
        }

        var snapshot = _lensPulse.GetSnapshot(sessionId);
        if (snapshot is null)
        {
            return true;
        }

        if (snapshot.Requests.Any(static request =>
                string.Equals(request.State, "open", StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        var turnState = snapshot.CurrentTurn.State?.Trim().ToLowerInvariant();
        if (turnState is "running" or "in_progress" or "started" or "submitted")
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(turnState))
        {
            return true;
        }

        var sessionState = snapshot.Session.State?.Trim().ToLowerInvariant();
        return sessionState is not "starting" and not "running";
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

    public async Task SendTurnAsync(string sessionId, LensTurnRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!UsesTurnQueue(sessionId))
        {
            if (!string.IsNullOrWhiteSpace(request.Text))
            {
                await SendPromptAsync(sessionId, request.Text, cancellationToken).ConfigureAwait(false);
            }

            return;
        }

        await _lensRuntime.StartTurnAsync(sessionId, request, cancellationToken).ConfigureAwait(false);
    }
}
