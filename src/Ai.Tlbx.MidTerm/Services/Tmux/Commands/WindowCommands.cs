namespace Ai.Tlbx.MidTerm.Services.Tmux.Commands;

/// <summary>
/// Handles: new-window, select-window, kill-window
/// </summary>
public sealed class WindowCommands
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly TmuxTargetResolver _targetResolver;
    private readonly TmuxLayoutBridge _layoutBridge;
    private readonly PaneCommands _paneCommands;

    public WindowCommands(
        TtyHostSessionManager sessionManager,
        TmuxTargetResolver targetResolver,
        TmuxLayoutBridge layoutBridge,
        PaneCommands paneCommands)
    {
        _sessionManager = sessionManager;
        _targetResolver = targetResolver;
        _layoutBridge = layoutBridge;
        _paneCommands = paneCommands;
    }

    /// <summary>
    /// Create a new session and focus it. Optionally sets name (-n) and working directory (-c).
    /// If positional args specify a command, send it to the new session via the PTY.
    /// </summary>
    public async Task<TmuxResult> NewWindowAsync(
        TmuxCommandParser.ParsedCommand cmd,
        CancellationToken ct)
    {
        var workingDirectory = cmd.GetFlag("-c");
        var name = cmd.GetFlag("-n");

        var session = await _sessionManager.CreateSessionAsync(
            null, 80, 24, workingDirectory, ct).ConfigureAwait(false);

        if (session is null)
        {
            return TmuxResult.Fail("failed to create window\n");
        }

        if (!string.IsNullOrEmpty(name))
        {
            await _sessionManager.SetSessionNameAsync(session.Id, name, isManual: true, ct)
                .ConfigureAwait(false);
        }

        await _paneCommands.SendCommandIfPresentAsync(cmd.Positional, session.Id, ct)
            .ConfigureAwait(false);

        _layoutBridge.RequestFocus(session.Id);
        return TmuxResult.Ok();
    }

    /// <summary>
    /// Focus the session identified by the -t target.
    /// </summary>
    public TmuxResult SelectWindow(TmuxCommandParser.ParsedCommand cmd, string? callerPaneId)
    {
        var target = cmd.GetFlag("-t");
        if (target is not null)
        {
            var sessionId = _targetResolver.ResolveToSessionId(target, callerPaneId);
            if (sessionId is not null)
            {
                _layoutBridge.RequestFocus(sessionId);
            }
        }
        return TmuxResult.Ok();
    }

    /// <summary>
    /// Close the targeted pane. Does not kill all panes (safety measure).
    /// </summary>
    public async Task<TmuxResult> KillWindowAsync(
        TmuxCommandParser.ParsedCommand cmd,
        string? callerPaneId,
        CancellationToken ct)
    {
        // kill-window kills all panes in the window.
        // Since we have a single virtual window, this would close all sessions.
        // For safety, only close the targeted pane.
        var target = cmd.GetFlag("-t");
        var sessionId = _targetResolver.ResolveToSessionId(target, callerPaneId);

        if (sessionId is not null)
        {
            await _sessionManager.CloseSessionAsync(sessionId, ct).ConfigureAwait(false);
        }

        return TmuxResult.Ok();
    }
}
