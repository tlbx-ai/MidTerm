using System.Diagnostics;
using System.Globalization;
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

            Process? process = new Process
            {
                StartInfo = _startInfoFactory()
            };

            try
            {
                if (!process.Start())
                {
                    return false;
                }

                if (process.WaitForExit(500))
                {
                    var stderr = process.StandardError.ReadToEnd().Trim();
                    var detail = string.IsNullOrWhiteSpace(stderr) ? "no error output" : stderr;
                    var exitCode = process.ExitCode;
                    Log.Warn(() => string.Create(CultureInfo.InvariantCulture, $"Sleep inhibitor backend {_backendName} exited immediately with code {exitCode}: {detail}"));
                    return false;
                }

                StoreOwnedProcess(process);
                return true;
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Sleep inhibitor backend {_backendName} failed to start: {ex.Message}");
                return false;
            }
            finally
            {
                process?.Dispose();
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
        var process = _process;
        if (process is null)
        {
            return;
        }

        _process = null;

        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(2000);
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Sleep inhibitor backend {_backendName} failed to stop cleanly: {ex.Message}");
        }
        finally
        {
            process.Dispose();
        }
    }

    private void StoreOwnedProcess(Process process)
    {
        var previous = _process;
        _process = process;
        previous?.Dispose();
    }
}
