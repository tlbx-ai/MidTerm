using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Power;

internal sealed class ProcessSystemSleepInhibitorBackend : ISystemSleepInhibitorBackend
{
    private readonly Func<ProcessStartInfo> _startInfoFactory;
    private readonly string _backendName;
    private readonly object _lock = new();
    private Process? _process;
    private bool _disposed;

    public ProcessSystemSleepInhibitorBackend(Func<ProcessStartInfo> startInfoFactory, string backendName)
    {
        _startInfoFactory = startInfoFactory;
        _backendName = backendName;
    }

    public bool Activate()
    {
        lock (_lock)
        {
            if (_disposed)
            {
                return false;
            }

            if (_process is not null && !_process.HasExited)
            {
                return true;
            }

            DisposeProcessLocked();

            var process = new Process
            {
                StartInfo = _startInfoFactory()
            };

            try
            {
                if (!process.Start())
                {
                    process.Dispose();
                    return false;
                }

                if (process.WaitForExit(500))
                {
                    var stderr = process.StandardError.ReadToEnd().Trim();
                    var detail = string.IsNullOrWhiteSpace(stderr) ? "no error output" : stderr;
                    var exitCode = process.ExitCode;
                    process.Dispose();
                    Log.Warn(() => $"Sleep inhibitor backend {_backendName} exited immediately with code {exitCode}: {detail}");
                    return false;
                }

                _process = process;
                return true;
            }
            catch (Exception ex)
            {
                process.Dispose();
                Log.Warn(() => $"Sleep inhibitor backend {_backendName} failed to start: {ex.Message}");
                return false;
            }
        }
    }

    public void Deactivate()
    {
        lock (_lock)
        {
            DisposeProcessLocked();
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
            DisposeProcessLocked();
        }
    }

    private void DisposeProcessLocked()
    {
        if (_process is null)
        {
            return;
        }

        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(2000);
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Sleep inhibitor backend {_backendName} failed to stop cleanly: {ex.Message}");
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }
}
