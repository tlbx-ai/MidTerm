namespace Ai.Tlbx.MidTerm.Services.Browser;

using Ai.Tlbx.MidTerm.Models.Browser;

public sealed class BrowserUiBridge
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, ListenerRegistration> _listeners = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TaskCompletionSource<AgentHistoryWheelResult>> _pendingAgentWheels = new(StringComparer.Ordinal);
    private readonly MainBrowserService _mainBrowserService;
    private readonly BrowserPreviewOwnerService? _previewOwnerService;

    public BrowserUiBridge(
        MainBrowserService mainBrowserService,
        BrowserPreviewOwnerService? previewOwnerService = null)
    {
        _mainBrowserService = mainBrowserService;
        _previewOwnerService = previewOwnerService;
    }

    public int ConnectedBrowserCount
    {
        get
        {
            lock (_lock)
            {
                return _listeners.Count;
            }
        }
    }

    public void RegisterListener(
        string connectionId,
        string browserId,
        Action<string?, string?> detach,
        Action<string?, string?> dock,
        Action<string?, string?, int, int> viewport,
        Action<string?, string?, string, bool> open,
        Action<string?, string?, string, string?>? mobileDevice = null,
        Action<string, string, double, int>? agentWheel = null)
    {
        lock (_lock)
        {
            _listeners[connectionId] = new ListenerRegistration
            {
                ConnectionId = connectionId,
                BrowserId = browserId,
                Detach = detach,
                Dock = dock,
                Viewport = viewport,
                Open = open,
                MobileDevice = mobileDevice,
                AgentWheel = agentWheel,
                ConnectedAtUtc = DateTimeOffset.UtcNow
            };
        }
    }

    public async Task<AgentHistoryWheelResult> RequestAgentWheelAsync(
        string sessionId,
        double deltaY,
        int steps,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return new AgentHistoryWheelResult { Error = "sessionId required" };
        }

        if (!TryGetTargetListener(sessionId, null, out var target, out var error))
        {
            return new AgentHistoryWheelResult { SessionId = sessionId, Error = error };
        }

        if (target.AgentWheel is null)
        {
            return new AgentHistoryWheelResult
            {
                SessionId = sessionId,
                Error = "The connected tlbx browser UI does not support ACP wheel control. Reload it and retry."
            };
        }

        var requestId = Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<AgentHistoryWheelResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_lock)
        {
            _pendingAgentWheels[requestId] = completion;
        }

        try
        {
            target.AgentWheel(requestId, sessionId, deltaY, Math.Clamp(steps, 1, 100));
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            return await completion.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new AgentHistoryWheelResult
            {
                RequestId = requestId,
                SessionId = sessionId,
                Error = "Timed out waiting for the tlbx browser UI to complete the ACP wheel command."
            };
        }
        finally
        {
            lock (_lock)
            {
                _pendingAgentWheels.Remove(requestId);
            }
        }
    }

    public bool CompleteAgentWheel(AgentHistoryWheelResult result)
    {
        TaskCompletionSource<AgentHistoryWheelResult>? completion;
        lock (_lock)
        {
            _pendingAgentWheels.TryGetValue(result.RequestId, out completion);
        }

        return completion?.TrySetResult(result) == true;
    }

    public void UnregisterListener(string connectionId)
    {
        lock (_lock)
        {
            _listeners.Remove(connectionId);
        }
    }

    public bool RequestDetach(string? sessionId, string? previewName, out string error)
    {
        error = "";
        if (!TryGetTargetListener(sessionId, previewName, out var target, out error))
        {
            return false;
        }

        target.Detach(sessionId, previewName);
        return true;
    }

    public bool RequestDock(string? sessionId, string? previewName, out string error)
    {
        error = "";
        if (!TryGetTargetListener(sessionId, previewName, out var target, out error))
        {
            return false;
        }

        target.Dock(sessionId, previewName);
        return true;
    }

    public bool RequestViewport(string? sessionId, string? previewName, int width, int height, out string error)
    {
        error = "";
        if (!TryGetTargetListener(sessionId, previewName, out var target, out error))
        {
            return false;
        }

        target.Viewport(sessionId, previewName, width, height);
        return true;
    }

    public bool RequestOpen(
        string? sessionId,
        string? previewName,
        string url,
        bool activateSession,
        out string error)
    {
        error = "";
        if (!TryGetTargetListener(sessionId, previewName, out var target, out error))
        {
            return false;
        }

        target.Open(sessionId, previewName, url, activateSession);
        return true;
    }

    public async Task<(bool Success, string Error)> RequestOpenWhenAvailableAsync(
        string? sessionId,
        string? previewName,
        string url,
        bool activateSession,
        TimeSpan? timeout = null,
        TimeSpan? pollInterval = null,
        CancellationToken cancellationToken = default)
    {
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(4));
        var retryDelay = pollInterval ?? TimeSpan.FromMilliseconds(100);
        var lastError = "";

        while (true)
        {
            if (RequestOpen(sessionId, previewName, url, activateSession, out lastError))
            {
                return (true, "");
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                return (false, lastError);
            }

            await Task.Delay(retryDelay, cancellationToken).ConfigureAwait(false);
        }
    }

    public bool RequestMobileDevice(
        string? sessionId,
        string? previewName,
        string action,
        string? profile,
        out string error)
    {
        error = "";
        if (!IsSupportedMobileDeviceAction(action))
        {
            error = "Unsupported mobile device action. Use status, open, rotate, keyboard, background, foreground, reload, screenshot, or close.";
            return false;
        }

        if (!TryGetTargetListener(sessionId, previewName, out var target, out error))
        {
            return false;
        }

        if (target.MobileDevice is null)
        {
            error = "The connected tlbx browser UI does not support mobile device control. Reload it and retry.";
            return false;
        }

        target.MobileDevice(sessionId, previewName, action.Trim().ToLowerInvariant(), profile);
        return true;
    }

    private static bool IsSupportedMobileDeviceAction(string action)
    {
        return !string.IsNullOrWhiteSpace(action) && action.Trim().ToLowerInvariant() is
            "status" or "open" or "rotate" or "keyboard" or "background" or "foreground" or
            "reload" or "screenshot" or "close";
    }

    public bool RequestClaim(string? sessionId, string? previewName, out string error)
    {
        error = "";
        if (_previewOwnerService is null)
        {
            error = "Preview ownership is not available in this tlbx instance.";
            return false;
        }

        if (string.IsNullOrWhiteSpace(sessionId))
        {
            error = "sessionId required";
            return false;
        }

        ListenerRegistration[] listeners;
        lock (_lock)
        {
            if (_listeners.Count == 0)
            {
                error = "No tlbx browser UI is connected. Open the owning tlbx browser tab first; the preview target alone cannot drive /ws/state.";
                return false;
            }

            listeners = _listeners.Values.ToArray();
        }

        var target = SelectClaimListener(listeners);
        if (target is null || string.IsNullOrWhiteSpace(target.BrowserId))
        {
            error = listeners.Length > 1
                ? "Multiple tlbx browser UIs are connected, but none is the leading browser. Claim leading-browser ownership in the intended tab, then retry mt_claim_preview."
                : "A tlbx browser UI is connected, but it did not report a browser identity. Reload the tlbx tab, then retry mt_claim_preview.";
            return false;
        }

        _previewOwnerService.Claim(sessionId, previewName, target.BrowserId);
        return true;
    }

    public bool RequestClaimMain(string? browserId, out string claimedBrowserId, out string error)
    {
        claimedBrowserId = "";
        error = "";

        ListenerRegistration[] listeners;
        lock (_lock)
        {
            if (_listeners.Count == 0)
            {
                error = "No tlbx browser UI is connected. Open the owning tlbx browser tab first; the preview target alone cannot drive /ws/state.";
                return false;
            }

            listeners = _listeners.Values.ToArray();
        }

        ListenerRegistration? target;
        if (string.IsNullOrWhiteSpace(browserId))
        {
            target = SelectClaimListener(listeners);
        }
        else
        {
            target = SelectListenerByBrowserId(listeners, browserId.Trim());
        }

        if (target is null || string.IsNullOrWhiteSpace(target.BrowserId))
        {
            error = string.IsNullOrWhiteSpace(browserId)
                ? "Multiple tlbx browser UIs are connected. Pass --browser with the intended browser id to claim the leading browser deterministically."
                : $"No connected tlbx browser UI matches '{browserId}'.";
            return false;
        }

        _mainBrowserService.Claim(target.BrowserId);
        claimedBrowserId = target.BrowserId;
        return true;
    }

    private bool TryGetTargetListener(
        string? sessionId,
        string? previewName,
        out ListenerRegistration target,
        out string error)
    {
        ListenerRegistration[] listeners;
        lock (_lock)
        {
            if (_listeners.Count == 0)
            {
                error = "No tlbx browser UI is connected. Open the owning tlbx browser tab first; the preview target alone cannot drive /ws/state.";
                target = null!;
                return false;
            }

            listeners = _listeners.Values.ToArray();
        }

        var currentOwnerBrowserId = _previewOwnerService?.GetOwnerBrowserId(sessionId, previewName);
        if (!string.IsNullOrWhiteSpace(currentOwnerBrowserId))
        {
            var ownerListener = SelectListenerByBrowserId(listeners, currentOwnerBrowserId);
            if (ownerListener is not null)
            {
                target = ownerListener;
                error = "";
                return true;
            }

            var replacement = SelectClaimListener(listeners);
            if (replacement is not null && !string.IsNullOrWhiteSpace(replacement.BrowserId))
            {
                _previewOwnerService?.Claim(sessionId, previewName, replacement.BrowserId);
                target = replacement;
                error = "";
                return true;
            }

            error = $"Preview '{previewName ?? WebPreview.WebPreviewService.DefaultPreviewName}' in session '{sessionId ?? "(any)"}' is owned by browser '{currentOwnerBrowserId}', but that tlbx browser is not currently attached to /ws/state and no connected leading browser can reclaim it deterministically.";
            target = null!;
            return false;
        }

        var candidates = listeners.AsEnumerable();
        var mainBrowserId = _mainBrowserService.GetMainBrowserId();
        if (!string.IsNullOrWhiteSpace(mainBrowserId))
        {
            var mainCandidates = candidates
                .Where(listener => BrowserIdentity.AreSameBrowser(listener.BrowserId, mainBrowserId))
                .ToArray();
            if (mainCandidates.Length > 0)
            {
                candidates = mainCandidates;
            }
        }

        target = candidates
            .OrderByDescending(listener => listener.ConnectedAtUtc)
            .First();
        _previewOwnerService?.Claim(sessionId, previewName, target.BrowserId);
        error = "";
        return true;
    }

    private ListenerRegistration? SelectClaimListener(ListenerRegistration[] listeners)
    {
        if (listeners.Length == 0)
        {
            return null;
        }

        var candidates = listeners.AsEnumerable();
        var mainBrowserId = _mainBrowserService.GetMainBrowserId();
        if (!string.IsNullOrWhiteSpace(mainBrowserId))
        {
            var mainCandidates = candidates
                .Where(listener => BrowserIdentity.AreSameBrowser(listener.BrowserId, mainBrowserId))
                .ToArray();
            if (mainCandidates.Length > 0)
            {
                candidates = mainCandidates;
            }
        }

        var candidateArray = candidates.ToArray();
        var distinctBrowserClients = candidateArray
            .Select(listener => listener.BrowserId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Cast<string>()
            .Select(BrowserIdentity.GetClientPart)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (distinctBrowserClients.Length > 1)
        {
            return null;
        }

        return candidateArray
            .OrderByDescending(listener => listener.ConnectedAtUtc)
            .FirstOrDefault();
    }

    private static ListenerRegistration? SelectListenerByBrowserId(
        ListenerRegistration[] listeners,
        string browserId)
    {
        var exact = listeners
            .Where(listener => string.Equals(listener.BrowserId, browserId, StringComparison.Ordinal))
            .OrderByDescending(listener => listener.ConnectedAtUtc)
            .FirstOrDefault();
        if (exact is not null)
        {
            return exact;
        }

        return listeners
            .Where(listener => BrowserIdentity.AreSameBrowser(listener.BrowserId, browserId))
            .OrderByDescending(listener => listener.ConnectedAtUtc)
            .FirstOrDefault();
    }

    private sealed class ListenerRegistration
    {
        public string ConnectionId { get; init; } = "";
        public string BrowserId { get; init; } = "";
        public required Action<string?, string?> Detach { get; init; }
        public required Action<string?, string?> Dock { get; init; }
        public required Action<string?, string?, int, int> Viewport { get; init; }
        public required Action<string?, string?, string, bool> Open { get; init; }
        public Action<string?, string?, string, string?>? MobileDevice { get; init; }
        public Action<string, string, double, int>? AgentWheel { get; init; }
        public DateTimeOffset ConnectedAtUtc { get; init; }
    }
}
