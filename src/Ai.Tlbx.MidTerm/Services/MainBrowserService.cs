namespace Ai.Tlbx.MidTerm.Services;

public sealed class MainBrowserService
{
    private readonly Lock _lock = new();
    private object? _mainBrowserToken;

    public event Action? OnMainBrowserChanged;

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
}
