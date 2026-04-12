using System.Globalization;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensRuntimeService : IAsyncDisposable, ISessionLensHeatSource
{
    private readonly AiCliProfileService _profileService;
    private readonly SessionLensHostRuntimeService _hostRuntime;

    public SessionLensRuntimeService(
        TtyHostSessionManager sessionManager,
        AiCliProfileService profileService,
        SessionLensHostRuntimeService hostRuntime,
        SettingsService? settingsService = null)
    {
        _profileService = profileService;
        _hostRuntime = hostRuntime;
        sessionManager.OnSessionClosed += Forget;
    }

    public async Task<bool> EnsureAttachedAsync(
        string sessionId,
        SessionInfoDto session,
        string? resumeThreadIdOverride = null,
        CancellationToken ct = default)
    {
        if (IsAttached(sessionId))
        {
            return true;
        }

        var profile = _profileService.NormalizeProfile(null, session);
        if (profile is not AiCliProfileService.CodexProfile and not AiCliProfileService.ClaudeProfile)
        {
            return false;
        }

        var cwd = session.CurrentDirectory;
        if (string.IsNullOrWhiteSpace(cwd) || !Directory.Exists(cwd))
        {
            return false;
        }

        if (!_hostRuntime.IsEnabledFor(profile))
        {
            Log.Warn(() => $"Lens runtime attach refused for {sessionId}: mtagenthost is disabled for profile '{profile}'.");
            return false;
        }

        try
        {
            return await _hostRuntime.EnsureAttachedAsync(sessionId, profile, session, resumeThreadIdOverride, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Lens host attach failed for {sessionId}. {ex.Message}");
            await _hostRuntime.DetachAsync(sessionId, ct).ConfigureAwait(false);
            return false;
        }
    }

    public async Task DiscoverExistingSessionsAsync(
        TtyHostSessionManager sessionManager,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(sessionManager);

        var recovered = 0;
        foreach (var session in sessionManager.GetSessionList().Sessions)
        {
            ct.ThrowIfCancellationRequested();

            var profile = _profileService.NormalizeProfile(null, session);
            if (!_hostRuntime.IsEnabledFor(profile) || !_hostRuntime.MayHaveRecoverableHost(session.Id))
            {
                continue;
            }

            try
            {
                if (await _hostRuntime.RecoverExistingHostAsync(session.Id, profile, session, ct: ct).ConfigureAwait(false))
                {
                    recovered++;
                }
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Lens runtime recovery failed for {session.Id}: {ex.Message}");
                await _hostRuntime.DetachAsync(session.Id, ct).ConfigureAwait(false);
            }
        }

        Log.Info(() => string.Create(CultureInfo.InvariantCulture, $"SessionLensRuntimeService: Recovered {recovered} owned Lens runtimes on startup."));
    }

    public bool IsAttached(string sessionId)
    {
        return _hostRuntime.OwnsSession(sessionId);
    }

    public Task DetachAsync(string sessionId, CancellationToken ct = default)
    {
        return _hostRuntime.DetachAsync(sessionId, ct);
    }

    public bool TryGetRuntimeSummary(string sessionId, out LensRuntimeSummary summary)
    {
        return _hostRuntime.TryGetRuntimeSummary(sessionId, out summary);
    }

    public bool HasHistory(string sessionId)
    {
        return _hostRuntime.HasHistory(sessionId);
    }

    public bool TryGetCachedHistoryWindow(string sessionId, out LensHistoryWindowResponse historyWindow)
    {
        return _hostRuntime.TryGetCachedHistoryWindow(sessionId, out historyWindow);
    }

    public SessionLensHeatSnapshot GetHeatSnapshot(string sessionId)
    {
        if (!_hostRuntime.TryGetCachedHistoryWindow(sessionId, out var historyWindow))
        {
            return SessionLensHeatSnapshot.Cold;
        }

        if (!ShouldSurfaceWorkingHeat(historyWindow))
        {
            return SessionLensHeatSnapshot.Cold;
        }

        return new SessionLensHeatSnapshot
        {
            CurrentHeat = 1,
            LastActivityAt = historyWindow.Session.LastEventAt ?? historyWindow.CurrentTurn.StartedAt
        };
    }

    public Task<LensHistoryWindowResponse?> GetHistoryWindowAsync(
        string sessionId,
        int? startIndex = null,
        int? count = null,
        CancellationToken ct = default)
    {
        return _hostRuntime.GetHistoryWindowAsync(sessionId, startIndex, count, ct);
    }

    public LensHistoryPatchSubscription SubscribeHistoryPatches(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        return _hostRuntime.SubscribeHistoryPatches(sessionId, cancellationToken);
    }

    public async Task<bool> TrySendPromptAsync(
        string sessionId,
        SessionPromptRequest request,
        CancellationToken ct = default)
    {
        if (!_hostRuntime.OwnsSession(sessionId))
        {
            return false;
        }

        return await _hostRuntime.TrySendPromptAsync(sessionId, request, ct).ConfigureAwait(false);
    }

    public async Task<LensTurnStartResponse> StartTurnAsync(
        string sessionId,
        LensTurnRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!_hostRuntime.OwnsSession(sessionId))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        return await _hostRuntime.StartTurnAsync(sessionId, request, ct).ConfigureAwait(false);
    }

    public async Task<LensCommandAcceptedResponse> InterruptTurnAsync(
        string sessionId,
        LensInterruptRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        if (!_hostRuntime.OwnsSession(sessionId))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        return await _hostRuntime.InterruptTurnAsync(sessionId, request, ct).ConfigureAwait(false);
    }

    public async Task<LensCommandAcceptedResponse> ResolveRequestAsync(
        string sessionId,
        string requestId,
        LensRequestDecisionRequest request,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentNullException.ThrowIfNull(request);

        if (!_hostRuntime.OwnsSession(sessionId))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        return await _hostRuntime.ResolveRequestAsync(sessionId, requestId, request, ct).ConfigureAwait(false);
    }

    public async Task<LensCommandAcceptedResponse> ResolveUserInputAsync(
        string sessionId,
        string requestId,
        LensUserInputAnswerRequest request,
        CancellationToken ct = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentNullException.ThrowIfNull(request);

        if (!_hostRuntime.OwnsSession(sessionId))
        {
            throw new InvalidOperationException("Lens runtime is not attached.");
        }

        return await _hostRuntime.ResolveUserInputAsync(sessionId, requestId, request, ct).ConfigureAwait(false);
    }

    public void Forget(string sessionId)
    {
        _hostRuntime.Forget(sessionId);
    }

    public ValueTask DisposeAsync()
    {
        return ValueTask.CompletedTask;
    }

    private static bool ShouldSurfaceWorkingHeat(LensHistoryWindowResponse historyWindow)
    {
        if (historyWindow.Requests.Any(static request => string.Equals(request.State, "open", StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        if (IsWorkingTurnState(historyWindow.CurrentTurn.State))
        {
            return true;
        }

        return string.IsNullOrWhiteSpace(historyWindow.CurrentTurn.State) &&
               IsWorkingSessionState(historyWindow.Session.State);
    }

    private static bool IsWorkingTurnState(string? state)
    {
        return state?.Trim().ToLowerInvariant() switch
        {
            "running" => true,
            "in_progress" => true,
            "started" => true,
            "submitted" => true,
            _ => false
        };
    }

    private static bool IsWorkingSessionState(string? state)
    {
        return state?.Trim().ToLowerInvariant() switch
        {
            "starting" => true,
            "running" => true,
            _ => false
        };
    }
}

public sealed class LensRuntimeSummary
{
    public string SessionId { get; init; } = string.Empty;
    public string Profile { get; init; } = string.Empty;
    public string TransportKey { get; init; } = string.Empty;
    public string TransportLabel { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public string StatusLabel { get; init; } = string.Empty;
    public string? LastError { get; init; }
    public DateTimeOffset? LastEventAt { get; init; }
    public string? AssistantText { get; init; }
    public string? UnifiedDiff { get; init; }
    public string? PendingQuestion { get; init; }
    public List<AgentSessionVibeActivity> Activities { get; init; } = [];
}
