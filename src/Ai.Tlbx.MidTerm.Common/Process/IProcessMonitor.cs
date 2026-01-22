namespace Ai.Tlbx.MidTerm.Common.Process;

/// <summary>
/// Platform abstraction for monitoring the shell's direct child process.
/// No grandchildren tracking - monitors only the immediate foreground process.
/// </summary>
public interface IProcessMonitor : IDisposable
{
    /// <summary>
    /// Fired when the foreground process changes (new child spawned or child exited).
    /// </summary>
    event Action<ForegroundProcessInfo>? OnForegroundChanged;

    /// <summary>
    /// Start monitoring the shell process for direct child changes.
    /// </summary>
    void StartMonitoring(int shellPid);

    /// <summary>
    /// Stop monitoring.
    /// </summary>
    void StopMonitoring();

    /// <summary>
    /// Get current foreground process info synchronously.
    /// Returns shell info if no child process is running.
    /// </summary>
    ForegroundProcessInfo GetCurrentForeground();

    /// <summary>
    /// Get the current working directory of the shell process.
    /// </summary>
    string? GetShellCwd();
}
