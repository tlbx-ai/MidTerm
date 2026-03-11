using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Power;

internal sealed class SystemSleepInhibitorService : IDisposable
{
    private readonly ISystemSleepInhibitorBackend _backend;
    private readonly object _lock = new();
    private bool _enabled;
    private int _sessionCount;
    private bool _desiredInhibiting;
    private bool _inhibiting;
    private bool _disposed;

    public SystemSleepInhibitorService()
        : this(SystemSleepInhibitorBackendFactory.Create())
    {
    }

    internal SystemSleepInhibitorService(ISystemSleepInhibitorBackend backend)
    {
        _backend = backend;
    }

    public void UpdateEnabled(bool enabled)
    {
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            _enabled = enabled;
            ReconcileStateLocked();
        }
    }

    public void UpdateSessionCount(int sessionCount)
    {
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            _sessionCount = Math.Max(0, sessionCount);
            ReconcileStateLocked();
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;

            try
            {
                if (_inhibiting)
                {
                    _backend.Deactivate();
                    _inhibiting = false;
                }
            }
            catch (Exception ex)
            {
                Log.Exception(ex, "SystemSleepInhibitorService.Dispose");
            }
            finally
            {
                _backend.Dispose();
            }
        }
    }

    private void ReconcileStateLocked()
    {
        var shouldInhibit = _enabled && _sessionCount > 0;
        if (shouldInhibit == _desiredInhibiting)
        {
            return;
        }

        _desiredInhibiting = shouldInhibit;

        if (shouldInhibit)
        {
            _inhibiting = _backend.Activate();
            if (_inhibiting)
            {
                Log.Info(() => $"Sleep inhibitor enabled for {_sessionCount} active session(s)");
            }
            else
            {
                Log.Warn(() => "Failed to enable sleep inhibitor for active MidTerm sessions");
            }

            return;
        }

        try
        {
            if (_inhibiting)
            {
                _backend.Deactivate();
                Log.Info(() => "Sleep inhibitor disabled");
            }
        }
        catch (Exception ex)
        {
            Log.Exception(ex, "SystemSleepInhibitorService.Deactivate");
        }
        finally
        {
            _inhibiting = false;
        }
    }
}
