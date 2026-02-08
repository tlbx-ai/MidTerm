using System.Text;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Evaluates tmux format strings like #{pane_id}, #{pane_width}, etc.
/// </summary>
public sealed partial class TmuxFormatter
{
    private readonly TmuxPaneMapper _paneMapper;
    private readonly TtyHostSessionManager _sessionManager;

    public TmuxFormatter(TmuxPaneMapper paneMapper, TtyHostSessionManager sessionManager)
    {
        _paneMapper = paneMapper;
        _sessionManager = sessionManager;
    }

    [GeneratedRegex(@"#\{([^}]+)\}")]
    private static partial Regex FormatVariableRegex();

    /// <summary>
    /// Evaluate a tmux format string, replacing #{variable} tokens with session values.
    /// </summary>
    public string Evaluate(string format, SessionInfoDto session, bool isActive)
    {
        var paneIndex = _paneMapper.SessionIdToPaneIndex(session.Id) ?? 0;
        var totalPanes = _sessionManager.GetSessionList().Sessions.Count;

        return FormatVariableRegex().Replace(format, match =>
        {
            var variable = match.Groups[1].Value;
            return ResolveVariable(variable, session, paneIndex, isActive, totalPanes);
        });
    }

    private static string ResolveVariable(
        string variable,
        SessionInfoDto session,
        int paneIndex,
        bool isActive,
        int totalPanes)
    {
        return variable switch
        {
            "pane_id" => $"%{paneIndex}",
            "pane_index" => paneIndex.ToString(),
            "pane_pid" => session.Pid.ToString(),
            "pane_width" => session.Cols.ToString(),
            "pane_height" => session.Rows.ToString(),
            "pane_current_path" => session.CurrentDirectory ?? "",
            "pane_current_command" => session.ForegroundName ?? "",
            "pane_title" => session.Name ?? session.TerminalTitle ?? "",
            "pane_active" => isActive ? "1" : "0",
            "pane_dead" => session.IsRunning ? "0" : "1",
            "pane_tty" => "",

            "session_id" => "$0",
            "session_name" => "MidTerm",
            "session_windows" => "1",
            "session_attached" => "1",
            "session_group" => "",
            "session_created" => new DateTimeOffset(session.CreatedAt).ToUnixTimeSeconds().ToString(),

            "window_id" => "@0",
            "window_index" => "0",
            "window_name" => "MidTerm",
            "window_width" => session.Cols.ToString(),
            "window_height" => session.Rows.ToString(),
            "window_panes" => totalPanes.ToString(),
            "window_active" => "1",
            "window_flags" => "*",

            "cursor_x" => "0",
            "cursor_y" => "0",
            "scroll_position" => "0",
            "alternate_on" => "0",

            _ => ""
        };
    }

    /// <summary>
    /// Formats a default pane line (when no -F format is specified).
    /// Matches tmux default: "0: [80x24] [history 0/2000, 0 bytes] %0 (active)"
    /// </summary>
    public string FormatDefaultPaneLine(SessionInfoDto session, bool isActive)
    {
        var paneIndex = _paneMapper.SessionIdToPaneIndex(session.Id) ?? 0;
        var active = isActive ? " (active)" : "";
        return $"{paneIndex}: [{session.Cols}x{session.Rows}] [history 0/2000, 0 bytes] %{paneIndex}{active}";
    }

    /// <summary>
    /// Format the default list-sessions line (when no -F format is specified).
    /// </summary>
    public string FormatDefaultSessionLine()
    {
        var sessions = _sessionManager.GetSessionList().Sessions;
        var paneCount = sessions.Count;
        var created = sessions.Count > 0 ? sessions[0].CreatedAt : DateTime.UtcNow;
        return $"MidTerm: {paneCount} windows (created {created:ddd MMM dd HH:mm:ss yyyy}) (attached)";
    }

    /// <summary>
    /// Format the default list-windows line (when no -F format is specified).
    /// </summary>
    public string FormatDefaultWindowLine()
    {
        var sessions = _sessionManager.GetSessionList().Sessions;
        var paneCount = sessions.Count;
        return $"0: MidTerm* ({paneCount} panes) [active]";
    }
}
