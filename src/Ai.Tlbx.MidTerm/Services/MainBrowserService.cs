using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class MainBrowserService
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, HashSet<object>> _browserConnections = new();
    private string? _mainBrowserId;

    public event Action? OnMainBrowserChanged;

    public bool HasMultipleClients
    {
        get
        {
            lock (_lock)
            {
                return _browserConnections.Count >= 2;
            }
        }
    }

    public void Register(string browserId, object connectionToken)
    {
        bool notify;
        lock (_lock)
        {
            if (!_browserConnections.TryGetValue(browserId, out var tokens))
            {
                tokens = new HashSet<object>(ReferenceEqualityComparer.Instance);
                _browserConnections[browserId] = tokens;
            }

            tokens.Add(connectionToken);

            if (_mainBrowserId is null)
            {
                // First browser ever (cold start) — auto-promote
                _mainBrowserId = browserId;
                Log.Verbose(() => $"[MainBrowser] Initial promote {browserId[..8]}");
                notify = true;
            }
            else if (_mainBrowserId == browserId)
            {
                // Main browser reconnected — notify so it gets fresh status
                notify = true;
            }
            else
            {
                // Another browser connected — notify if this is the 2nd unique browser
                notify = _browserConnections.Count == 2;
            }
        }
        if (notify) OnMainBrowserChanged?.Invoke();
    }

    public void Unregister(string browserId, object connectionToken)
    {
        bool changed;
        lock (_lock)
        {
            if (!_browserConnections.TryGetValue(browserId, out var tokens))
                return;

            tokens.Remove(connectionToken);

            if (tokens.Count == 0)
            {
                _browserConnections.Remove(browserId);
            }

            // _mainBrowserId is NOT cleared when the main browser disconnects.
            // It stays set so the browser retains main status when it reconnects.
            // Only Claim() from another browser can override it.

            // Notify if multi-client count changed (affects showButton for remaining clients)
            changed = !_browserConnections.ContainsKey(browserId);
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public void Claim(string browserId)
    {
        lock (_lock)
        {
            _mainBrowserId = browserId;
            Log.Verbose(() => $"[MainBrowser] Claimed by {browserId[..8]}");
        }
        OnMainBrowserChanged?.Invoke();
    }

    public void Release(string browserId)
    {
        bool changed;
        lock (_lock)
        {
            changed = _mainBrowserId == browserId;
            if (changed) _mainBrowserId = null;
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public bool IsMain(string browserId)
    {
        lock (_lock)
        {
            return _mainBrowserId == browserId;
        }
    }

    public string? GetMainBrowserId()
    {
        lock (_lock)
        {
            return _mainBrowserId;
        }
    }

    /// <summary>
    /// Whether the main browser button should be visible for this browser.
    /// True when 2+ browsers are connected, or when main is set to a different
    /// (possibly offline) browser so this one can claim.
    /// </summary>
    public bool ShouldShowButton(string browserId)
    {
        lock (_lock)
        {
            return _browserConnections.Count >= 2
                || (_mainBrowserId is not null && _mainBrowserId != browserId);
        }
    }
}
