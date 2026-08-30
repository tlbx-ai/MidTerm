using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Services.Browser;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class MainBrowserService
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, BrowserRegistration> _browserConnections = new(StringComparer.Ordinal);
    private readonly SettingsService? _settingsService;
    private string? _mainBrowserId;
    private bool _hasAssignedInitialMainBrowser;
    private long _revision;
    private long _activityOrder;

    public MainBrowserService(SettingsService settingsService)
        : this(settingsService, null)
    {
    }

    internal MainBrowserService(TimeProvider? timeProvider = null)
        : this(null, timeProvider)
    {
    }

    internal MainBrowserService(SettingsService? settingsService, TimeProvider? timeProvider)
    {
        _settingsService = settingsService;

        var stickyMainBrowserId = NormalizeBrowserId(settingsService?.Load().StickyMainBrowserId);
        if (stickyMainBrowserId is not null)
        {
            _mainBrowserId = stickyMainBrowserId;
            _hasAssignedInitialMainBrowser = true;
        }
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

            var connectionAdded = registration.ConnectionTokens.Add(connectionToken);

            if (IsStickyMainBrowserReconnectLocked(browserId))
            {
                _mainBrowserId = browserId;
                _hasAssignedInitialMainBrowser = true;
                Log.Verbose(() => $"[MainBrowser] Restored sticky leading browser {GetLogPrefix(browserId)}");
                notify = true;
            }
            else if (!_hasAssignedInitialMainBrowser)
            {
                // First browser ever (cold start) — auto-promote
                _mainBrowserId = browserId;
                _hasAssignedInitialMainBrowser = true;
                Log.Verbose(() => $"[MainBrowser] Initial promote {GetLogPrefix(browserId)}");
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

            notify |= connectionAdded;
            if (notify)
            {
                _revision++;
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

            var connectionRemoved = registration.ConnectionTokens.Remove(connectionToken);
            registration.ActiveConnections.Remove(connectionToken);
            registration.RefreshActivity();

            if (registration.ConnectionTokens.Count == 0)
            {
                _browserConnections.Remove(browserId);
            }

            // _mainBrowserId is NOT cleared when the main browser disconnects.
            // It stays set so the browser retains main status when it reconnects.
            // Only Claim() from another browser can override it.

            // Notify if multi-client count changed (affects showButton for remaining clients)
            changed = connectionRemoved;
            if (changed)
            {
                _revision++;
            }
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public void UpdateActivity(
        string browserId,
        object connectionToken,
        bool isActive,
        string? activeSessionId = null,
        string? activeSurface = null)
    {
        bool changed = false;
        lock (_lock)
        {
            if (!_browserConnections.TryGetValue(browserId, out var registration))
            {
                return;
            }

            var previousIsActive = registration.IsActive;
            var previousActiveSessionId = registration.ActiveSessionId;
            var previousActiveSurface = registration.ActiveSurface;
            var previousActiveConnectionCount = registration.ActiveConnections.Count;

            if (isActive)
            {
                if (!registration.ConnectionTokens.Contains(connectionToken))
                {
                    registration.ConnectionTokens.Add(connectionToken);
                }
                registration.ActiveConnections[connectionToken] = new BrowserActivity(
                    ++_activityOrder,
                    string.IsNullOrWhiteSpace(activeSessionId) ? null : activeSessionId,
                    string.IsNullOrWhiteSpace(activeSurface) ? null : activeSurface);
            }
            else
            {
                registration.ActiveConnections.Remove(connectionToken);
            }

            registration.RefreshActivity();
            changed = previousIsActive != registration.IsActive
                || previousActiveConnectionCount != registration.ActiveConnections.Count
                || !string.Equals(
                    previousActiveSessionId,
                    registration.ActiveSessionId,
                    StringComparison.Ordinal)
                || !string.Equals(previousActiveSurface, registration.ActiveSurface, StringComparison.Ordinal);
            if (changed)
            {
                _revision++;
            }
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public void Claim(string browserId)
    {
        var changed = false;
        lock (_lock)
        {
            changed = !string.Equals(_mainBrowserId, browserId, StringComparison.Ordinal);
            if (changed)
            {
                _mainBrowserId = browserId;
                _revision++;
                Log.Verbose(() => $"[MainBrowser] Claimed by {GetLogPrefix(browserId)}");
            }
        }
        // An explicit claim also establishes sticky ownership when the browser
        // was already auto-promoted during this process lifetime.
        PersistStickyMainBrowserId(browserId);
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public void Release(string browserId)
    {
        bool changed;
        lock (_lock)
        {
            changed = _mainBrowserId == browserId;
            if (changed)
            {
                _mainBrowserId = null;
                _revision++;
            }
        }
        if (changed) PersistStickyMainBrowserId(null);
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

    public List<BrowserSessionStatus> GetBrowserStatuses()
    {
        lock (_lock)
        {
            return GetBrowserStatusesLocked();
        }
    }

    public MainBrowserStatusMessage GetStatus(string browserId)
    {
        lock (_lock)
        {
            return new MainBrowserStatusMessage
            {
                Revision = _revision,
                IsMain = IsMainLocked(browserId),
                ShowButton = ShouldShowButtonLocked(browserId),
                Browsers = GetBrowserStatusesLocked()
            };
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
            return ShouldShowButtonLocked(browserId);
        }
    }

    private bool ShouldShowButtonLocked(string browserId)
    {
        return _browserConnections.Count >= 2
            || (_mainBrowserId is not null && _mainBrowserId != browserId)
            || (_mainBrowserId is null && _hasAssignedInitialMainBrowser);
    }

    private List<BrowserSessionStatus> GetBrowserStatusesLocked()
    {
        return _browserConnections
            .OrderByDescending(pair => IsMainLocked(pair.Key))
            .ThenBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => new BrowserSessionStatus
            {
                BrowserId = pair.Key,
                IsMain = IsMainLocked(pair.Key),
                IsActive = pair.Value.IsActive,
                ConnectionCount = pair.Value.ConnectionTokens.Count,
                ActiveConnectionCount = pair.Value.ActiveConnections.Count,
                ActiveSessionId = pair.Value.ActiveSessionId,
                ActiveSurface = pair.Value.ActiveSurface
            })
            .ToList();
    }

    private sealed class BrowserRegistration
    {
        public HashSet<object> ConnectionTokens { get; } = new(ReferenceEqualityComparer.Instance);
        public Dictionary<object, BrowserActivity> ActiveConnections { get; } = new(
            ReferenceEqualityComparer.Instance);
        public bool IsActive { get; set; }
        public string? ActiveSessionId { get; set; }
        public string? ActiveSurface { get; set; }

        public void RefreshActivity()
        {
            var latest = ActiveConnections.Values.MaxBy(activity => activity.Order);
            IsActive = latest is not null;
            ActiveSessionId = latest?.ActiveSessionId;
            ActiveSurface = latest?.ActiveSurface;
        }
    }

    private sealed record BrowserActivity(long Order, string? ActiveSessionId, string? ActiveSurface);

    private bool IsStickyMainBrowserReconnectLocked(string browserId)
    {
        if (string.IsNullOrWhiteSpace(_mainBrowserId))
        {
            return false;
        }

        if (string.Equals(browserId, _mainBrowserId, StringComparison.Ordinal))
        {
            return true;
        }

        return !_browserConnections.ContainsKey(_mainBrowserId)
            && BrowserIdentity.AreSameBrowser(browserId, _mainBrowserId);
    }

    private bool IsMainLocked(string browserId)
    {
        return string.Equals(browserId, _mainBrowserId, StringComparison.Ordinal);
    }

    private void PersistStickyMainBrowserId(string? browserId)
    {
        if (_settingsService is null)
        {
            return;
        }

        try
        {
            var settings = _settingsService.Load();
            settings.StickyMainBrowserId = browserId ?? "";
            _settingsService.Save(settings);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"[MainBrowser] Failed to persist sticky leading browser: {ex.Message}");
        }
    }

    private static string? NormalizeBrowserId(string? browserId)
    {
        return string.IsNullOrWhiteSpace(browserId) ? null : browserId.Trim();
    }

    private static string GetLogPrefix(string browserId)
    {
        return browserId.Length <= 8 ? browserId : browserId[..8];
    }
}
