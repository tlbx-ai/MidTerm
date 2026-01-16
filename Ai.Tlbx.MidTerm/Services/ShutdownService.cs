namespace Ai.Tlbx.MidTerm.Services;

public sealed class ShutdownService : IDisposable
{
    private readonly CancellationTokenSource _cts = new();
    private volatile bool _isShuttingDown;

    public CancellationToken Token => _cts.Token;

    public bool IsShuttingDown => _isShuttingDown;

    public void SignalShutdown()
    {
        _isShuttingDown = true;
        try
        {
            _cts.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    public void Dispose()
    {
        _cts.Dispose();
    }
}
