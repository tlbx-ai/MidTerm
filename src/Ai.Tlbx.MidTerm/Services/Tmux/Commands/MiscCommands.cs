using System.Collections.Concurrent;
using System.Diagnostics;

namespace Ai.Tlbx.MidTerm.Services.Tmux.Commands;

/// <summary>
/// Handles: run-shell, display-popup, wait-for
/// </summary>
public sealed class MiscCommands
{
    private readonly PaneCommands _paneCommands;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _waitChannels = new();

    public MiscCommands(PaneCommands paneCommands)
    {
        _paneCommands = paneCommands;
    }

    /// <summary>
    /// Execute a shell command and return its output. Uses pwsh on Windows, /bin/sh on Unix.
    /// </summary>
    public async Task<TmuxResult> RunShellAsync(
        TmuxCommandParser.ParsedCommand cmd,
        CancellationToken ct)
    {
        var background = cmd.HasFlag("-b");
        var command = cmd.Positional.Count > 0 ? string.Join(" ", cmd.Positional) : null;

        if (command is null)
        {
            return TmuxResult.Fail("usage: run-shell command\n");
        }

        var shell = OperatingSystem.IsWindows() ? "pwsh" : "/bin/sh";
        var shellArgs = OperatingSystem.IsWindows()
            ? $"-NoProfile -NoLogo -Command {command}"
            : $"-c {command}";

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = shell,
                Arguments = shellArgs,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            using var process = Process.Start(psi);
            if (process is null)
            {
                return TmuxResult.Fail("failed to start process\n");
            }

            if (background)
            {
                return TmuxResult.Ok();
            }

            var stdout = await process.StandardOutput.ReadToEndAsync(ct).ConfigureAwait(false);
            var stderr = await process.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
            await process.WaitForExitAsync(ct).ConfigureAwait(false);

            var output = stdout;
            if (!string.IsNullOrEmpty(stderr))
            {
                output += stderr;
            }

            return new TmuxResult(process.ExitCode == 0, output);
        }
        catch (Exception ex)
        {
            return TmuxResult.Fail($"run-shell error: {ex.Message}\n");
        }
    }

    /// <summary>
    /// Display a popup. Falls back to split-window behavior (no real popup support).
    /// </summary>
    public async Task<TmuxResult> DisplayPopupAsync(
        TmuxCommandParser.ParsedCommand cmd,
        string? callerPaneId,
        CancellationToken ct)
    {
        // display-popup falls back to split-window behavior
        return await _paneCommands.SplitWindowAsync(cmd, callerPaneId, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Wait for or signal a named channel. Supports -S (signal), -L (lock), -U (unlock).
    /// </summary>
    public async Task<TmuxResult> WaitForAsync(
        TmuxCommandParser.ParsedCommand cmd,
        CancellationToken ct)
    {
        if (cmd.Positional.Count == 0)
        {
            return TmuxResult.Fail("usage: wait-for channel\n");
        }

        var channel = cmd.Positional[0];
        var lockFlag = cmd.HasFlag("-L");
        var unlockFlag = cmd.HasFlag("-U");
        var signalFlag = cmd.HasFlag("-S");

        var semaphore = _waitChannels.GetOrAdd(channel, _ => new SemaphoreSlim(0, 1));

        if (signalFlag)
        {
            try { semaphore.Release(); }
            catch (SemaphoreFullException) { /* already signaled */ }
            return TmuxResult.Ok();
        }

        if (unlockFlag)
        {
            try { semaphore.Release(); }
            catch (SemaphoreFullException) { /* already unlocked */ }
            return TmuxResult.Ok();
        }

        if (lockFlag)
        {
            await semaphore.WaitAsync(ct).ConfigureAwait(false);
            CleanupChannel(channel);
            return TmuxResult.Ok();
        }

        // Default: wait for signal
        await semaphore.WaitAsync(ct).ConfigureAwait(false);
        CleanupChannel(channel);
        return TmuxResult.Ok();
    }

    private void CleanupChannel(string channel)
    {
        if (_waitChannels.TryRemove(channel, out var removed))
        {
            removed.Dispose();
        }
    }
}
