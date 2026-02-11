namespace Ai.Tlbx.MidTerm.Services;

public sealed class MainBrowserService
{
    private readonly Lock _lock = new();
    private readonly HashSet<object> _connections = new(ReferenceEqualityComparer.Instance);
    private readonly HashSet<string> _uniqueClientIds = new(StringComparer.Ordinal);
    private object? _mainBrowserToken;

    public event Action? OnMainBrowserChanged;

    public bool HasMultipleClients
    {
        get
        {
            lock (_lock)
            {
                return _uniqueClientIds.Count >= 2;
            }
        }
    }

    public void Register(object token, string? clientId = null)
    {
        bool promoted;
        bool newMultiClient = false;
        lock (_lock)
        {
            _connections.Add(token);
            promoted = _mainBrowserToken is null;
            if (promoted) _mainBrowserToken = token;

            if (clientId is not null && _uniqueClientIds.Add(clientId) && _uniqueClientIds.Count == 2)
            {
                newMultiClient = true;
            }
        }
        if (promoted || newMultiClient) OnMainBrowserChanged?.Invoke();
    }

    public void Unregister(object token)
    {
        bool changed;
        lock (_lock)
        {
            _connections.Remove(token);
            if (!ReferenceEquals(_mainBrowserToken, token))
            {
                changed = false;
            }
            else if (_connections.Count == 1)
            {
                _mainBrowserToken = GetSingleConnection();
                changed = true;
            }
            else
            {
                _mainBrowserToken = null;
                changed = true;
            }
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public void Claim(object token)
    {
        lock (_lock)
        {
            _mainBrowserToken = token;
        }
        OnMainBrowserChanged?.Invoke();
    }

    public void Release(object token)
    {
        bool changed;
        lock (_lock)
        {
            changed = ReferenceEquals(_mainBrowserToken, token);
            if (changed) _mainBrowserToken = null;
        }
        if (changed) OnMainBrowserChanged?.Invoke();
    }

    public bool IsMain(object token)
    {
        lock (_lock)
        {
            return ReferenceEquals(_mainBrowserToken, token);
        }
    }

    private object? GetSingleConnection()
    {
        foreach (var c in _connections) return c;
        return null;
    }
}
