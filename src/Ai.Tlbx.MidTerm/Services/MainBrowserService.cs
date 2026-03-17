using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class MainBrowserService
{
    private static readonly TimeSpan AutoPromoteAfterNoActiveTabs = TimeSpan.FromMinutes(3);
    private readonly Lock _lock = new();
    private readonly Dictionary<string, BrowserRegistration> _browserConnections = new();
    private readonly TimeProvider _timeProvider;
    private string? _mainBrowserId;
    private DateTimeOffset? _noActiveTabsSinceUtc;

    public MainBrowserService(TimeProvider? timeProvider = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

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
            if (!_browserConnections.TryGetValue(browserId, out var registration))
            {
                registration = new BrowserRegistration();
                _browserConnections[browserId] = registration;
            }

            registration.ConnectionTokens.Add(connectionToken);

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
            if (!_browserConnections.TryGetValue(browserId, out var registration))
                return;

            var hadActiveBrowsers = HasActiveBrowsersLocked();

            registration.ConnectionTokens.Remove(connectionToken);
            registration.ActiveConnectionTokens.Remove(connectionToken);

            if (registration.ConnectionTokens.Count == 0)
            {
                _browserConnections.Remove(browserId);
            }

            // _mainBrowserId is NOT cleared when the main browser disconnects.
            // It stays set so the browser retains main status when it reconnects.
            // Only Claim() from another browser can override it.

            UpdateNoActiveTimerLocked(hadActiveBrowsers);

            // Notify if multi-client count changed (affects showButton for remaining clients)
            changed = !_browserConnections.ContainsKey(browserId);
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public void UpdateActivity(string browserId, object connectionToken, bool isActive)
    {
        bool notify = false;
        lock (_lock)
        {
            if (!_browserConnections.TryGetValue(browserId, out var registration))
            {
                return;
            }

            var hadActiveBrowsers = HasActiveBrowsersLocked();

            if (isActive)
            {
                if (!registration.ConnectionTokens.Contains(connectionToken))
                {
                    registration.ConnectionTokens.Add(connectionToken);
                }
                registration.ActiveConnectionTokens.Add(connectionToken);
            }
            else
            {
                registration.ActiveConnectionTokens.Remove(connectionToken);
            }

            var shouldAutoPromote = ShouldAutoPromoteLocked(browserId, hadActiveBrowsers);
            UpdateNoActiveTimerLocked(hadActiveBrowsers);

            if (shouldAutoPromote && _mainBrowserId != browserId)
            {
                _mainBrowserId = browserId;
                Log.Verbose(() => $"[MainBrowser] Auto-promoted {browserId[..8]} after inactivity");
                notify = true;
            }
        }

        if (notify) OnMainBrowserChanged?.Invoke();
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

    private bool HasActiveBrowsersLocked()
    {
        return _browserConnections.Values.Any(x => x.ActiveConnectionTokens.Count > 0);
    }

    private int GetActiveBrowserCountLocked()
    {
        return _browserConnections.Values.Count(x => x.ActiveConnectionTokens.Count > 0);
    }

    private bool ShouldAutoPromoteLocked(string browserId, bool hadActiveBrowsers)
    {
        if (hadActiveBrowsers)
        {
            return false;
        }

        if (_noActiveTabsSinceUtc is null)
        {
            return false;
        }

        if (!_browserConnections.TryGetValue(browserId, out var registration)
            || registration.ActiveConnectionTokens.Count == 0)
        {
            return false;
        }

        if (GetActiveBrowserCountLocked() != 1)
        {
            return false;
        }

        return (_timeProvider.GetUtcNow() - _noActiveTabsSinceUtc.Value) >= AutoPromoteAfterNoActiveTabs;
    }

    private void UpdateNoActiveTimerLocked(bool hadActiveBrowsers)
    {
        var hasActiveBrowsers = HasActiveBrowsersLocked();
        if (hasActiveBrowsers)
        {
            _noActiveTabsSinceUtc = null;
            return;
        }

        if (hadActiveBrowsers || _noActiveTabsSinceUtc is null)
        {
            _noActiveTabsSinceUtc = _timeProvider.GetUtcNow();
        }
    }

    private sealed class BrowserRegistration
    {
        public HashSet<object> ConnectionTokens { get; } = new(ReferenceEqualityComparer.Instance);
        public HashSet<object> ActiveConnectionTokens { get; } = new(ReferenceEqualityComparer.Instance);
    }
}
