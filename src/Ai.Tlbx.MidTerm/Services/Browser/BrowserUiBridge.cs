namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserUiBridge
{
    public event Action? OnDetachRequested;
    public event Action? OnDockRequested;
    public event Action<int, int>? OnViewportRequested;
    public event Action<string>? OnOpenRequested;

    public void RequestDetach() => OnDetachRequested?.Invoke();

    public void RequestDock() => OnDockRequested?.Invoke();

    public void RequestViewport(int width, int height) => OnViewportRequested?.Invoke(width, height);

    public void RequestOpen(string url) => OnOpenRequested?.Invoke(url);
}
