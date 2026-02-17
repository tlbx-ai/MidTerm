namespace Ai.Tlbx.MidTerm.Services;

public sealed class MainBrowserService
{
    private readonly Lock _lock = new();
    private readonly HashSet<object> _connections = new(ReferenceEqualityComparer.Instance);
    private object? _mainBrowserToken;

    public event Action? OnMainBrowserChanged;

    public bool HasMultipleClients
    {
        get
        {
            lock (_lock)
            {
                return _connections.Count >= 2;
            }
        }
    }

    public void Register(object token)
    {
        bool notify;
        lock (_lock)
        {
            _connections.Add(token);
            var promoted = _mainBrowserToken is null;
            if (promoted) _mainBrowserToken = token;
            notify = promoted || _connections.Count == 2;
        }
        if (notify) OnMainBrowserChanged?.Invoke();
    }

    public void Unregister(object token)
    {
        bool changed;
        lock (_lock)
        {
            var wasMultiple = _connections.Count >= 2;
            _connections.Remove(token);
            var isMultiple = _connections.Count >= 2;

            if (!ReferenceEquals(_mainBrowserToken, token))
            {
                changed = wasMultiple != isMultiple;
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
