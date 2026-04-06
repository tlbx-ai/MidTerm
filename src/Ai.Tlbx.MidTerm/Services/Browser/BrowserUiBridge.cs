namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserUiBridge
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, ListenerRegistration> _listeners = new(StringComparer.Ordinal);
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
        Action<string?, string?, string, bool> open)
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
                ConnectedAtUtc = DateTimeOffset.UtcNow
            };
        }
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
                error = "No MidTerm browser UI is connected. Open the owning MidTerm browser tab first; the preview target alone cannot drive /ws/state.";
                target = null!;
                return false;
            }

            listeners = _listeners.Values.ToArray();
        }

        var resolvedOwnerBrowserId = _previewOwnerService?.ResolveOwnerBrowserId(
            sessionId,
            previewName,
            listeners.Select(listener => listener.BrowserId));

        if (!string.IsNullOrWhiteSpace(resolvedOwnerBrowserId))
        {
            var ownerListener = listeners
                .Where(listener => string.Equals(listener.BrowserId, resolvedOwnerBrowserId, StringComparison.Ordinal))
                .OrderByDescending(listener => listener.ConnectedAtUtc)
                .FirstOrDefault();
            if (ownerListener is not null)
            {
                target = ownerListener;
                error = "";
                return true;
            }

            error = $"Preview '{previewName ?? WebPreview.WebPreviewService.DefaultPreviewName}' in session '{sessionId ?? "(any)"}' is owned by browser '{resolvedOwnerBrowserId}', but that MidTerm browser is not currently attached to /ws/state.";
            target = null!;
            return false;
        }

        var candidates = listeners.AsEnumerable();
        var mainBrowserId = _mainBrowserService.GetMainBrowserId();
        if (!string.IsNullOrWhiteSpace(mainBrowserId))
        {
            var mainCandidates = candidates
                .Where(listener => string.Equals(listener.BrowserId, mainBrowserId, StringComparison.Ordinal))
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

    private sealed class ListenerRegistration
    {
        public string ConnectionId { get; init; } = "";
        public string BrowserId { get; init; } = "";
        public required Action<string?, string?> Detach { get; init; }
        public required Action<string?, string?> Dock { get; init; }
        public required Action<string?, string?, int, int> Viewport { get; init; }
        public required Action<string?, string?, string, bool> Open { get; init; }
        public DateTimeOffset ConnectedAtUtc { get; init; }
    }
}
