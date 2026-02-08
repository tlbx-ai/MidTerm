using System.Text;

namespace Ai.Tlbx.MidTerm.Services.Tmux.Commands;

/// <summary>
/// Handles: list-panes, list-sessions, list-windows, has-session
/// </summary>
public sealed class SessionCommands
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly TmuxPaneMapper _paneMapper;
    private readonly TmuxFormatter _formatter;

    public SessionCommands(
        TtyHostSessionManager sessionManager,
        TmuxPaneMapper paneMapper,
        TmuxFormatter formatter)
    {
        _sessionManager = sessionManager;
        _paneMapper = paneMapper;
        _formatter = formatter;
    }

    /// <summary>
    /// List all panes (sessions) with optional format string.
    /// </summary>
    public TmuxResult ListPanes(TmuxCommandParser.ParsedCommand cmd, string? callerPaneId)
    {
        var format = cmd.GetFlag("-F");
        var sessions = _sessionManager.GetSessionList().Sessions;
        var callerSessionId = callerPaneId is not null
            ? _paneMapper.PaneIdToSessionId(callerPaneId)
            : _paneMapper.GetActiveSessionId();

        var sb = new StringBuilder();
        foreach (var session in sessions)
        {
            var isActive = session.Id == callerSessionId;
            if (format is not null)
            {
                sb.AppendLine(_formatter.Evaluate(format, session, isActive));
            }
            else
            {
                sb.AppendLine(_formatter.FormatDefaultPaneLine(session, isActive));
            }
        }

        return TmuxResult.Ok(sb.ToString());
    }

    /// <summary>
    /// List sessions. MidTerm always has exactly one virtual tmux session.
    /// </summary>
    public TmuxResult ListSessions(TmuxCommandParser.ParsedCommand cmd)
    {
        var format = cmd.GetFlag("-F");
        var sessions = _sessionManager.GetSessionList().Sessions;

        if (format is not null && sessions.Count > 0)
        {
            var output = _formatter.Evaluate(format, sessions[0], true);
            return TmuxResult.Ok(output + "\n");
        }

        return TmuxResult.Ok(_formatter.FormatDefaultSessionLine() + "\n");
    }

    /// <summary>
    /// List windows. MidTerm always has exactly one virtual tmux window.
    /// </summary>
    public TmuxResult ListWindows(TmuxCommandParser.ParsedCommand cmd)
    {
        var format = cmd.GetFlag("-F");
        var sessions = _sessionManager.GetSessionList().Sessions;

        if (format is not null && sessions.Count > 0)
        {
            var output = _formatter.Evaluate(format, sessions[0], true);
            return TmuxResult.Ok(output + "\n");
        }

        return TmuxResult.Ok(_formatter.FormatDefaultWindowLine() + "\n");
    }

    /// <summary>
    /// Check if a session exists. Always succeeds (single virtual session).
    /// </summary>
    public TmuxResult HasSession(TmuxCommandParser.ParsedCommand cmd)
    {
        // In MidTerm, we always have exactly one virtual session
        // has-session returns 0 (success) if the session exists
        return TmuxResult.Ok();
    }
}
