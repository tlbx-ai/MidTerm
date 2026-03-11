namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserUiBridge
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, ListenerRegistration> _listeners = new();
    private readonly MainBrowserService _mainBrowserService;

    public BrowserUiBridge(MainBrowserService mainBrowserService)
    {
        _mainBrowserService = mainBrowserService;
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
        Action detach,
        Action dock,
        Action<int, int> viewport,
        Action<string> open)
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

    public bool RequestDetach(out string error)
    {
        error = "";
        if (!TryGetTargetListener(out var target, out error))
        {
            return false;
        }

        target.Detach();
        return true;
    }

    public bool RequestDock(out string error)
    {
        error = "";
        if (!TryGetTargetListener(out var target, out error))
        {
            return false;
        }

        target.Dock();
        return true;
    }

    public bool RequestViewport(int width, int height, out string error)
    {
        error = "";
        if (!TryGetTargetListener(out var target, out error))
        {
            return false;
        }

        target.Viewport(width, height);
        return true;
    }

    public bool RequestOpen(string url, out string error)
    {
        error = "";
        if (!TryGetTargetListener(out var target, out error))
        {
            return false;
        }

        target.Open(url);
        return true;
    }

    private bool TryGetTargetListener(out ListenerRegistration target, out string error)
    {
        lock (_lock)
        {
            if (_listeners.Count == 0)
            {
                error = "No MidTerm browser UI is connected. Open MidTerm in a browser tab first.";
                target = null!;
                return false;
            }

            var candidates = _listeners.Values.AsEnumerable();
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
            error = "";
            return true;
        }
    }

    private sealed class ListenerRegistration
    {
        public string ConnectionId { get; init; } = "";
        public string BrowserId { get; init; } = "";
        public required Action Detach { get; init; }
        public required Action Dock { get; init; }
        public required Action<int, int> Viewport { get; init; }
        public required Action<string> Open { get; init; }
        public DateTimeOffset ConnectedAtUtc { get; init; }
    }
}
