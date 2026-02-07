using System.Text;

namespace Ai.Tlbx.MidTerm.Services.Tmux.Commands;

/// <summary>
/// Handles: send-keys, display-message, capture-pane
/// </summary>
public sealed class IoCommands
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly TmuxTargetResolver _targetResolver;
    private readonly TmuxFormatter _formatter;

    public IoCommands(
        TtyHostSessionManager sessionManager,
        TmuxTargetResolver targetResolver,
        TmuxFormatter formatter)
    {
        _sessionManager = sessionManager;
        _targetResolver = targetResolver;
        _formatter = formatter;
    }

    /// <summary>
    /// Send key input to a pane. Supports named keys, control keys, and literal text.
    /// </summary>
    public async Task<TmuxResult> SendKeysAsync(
        TmuxCommandParser.ParsedCommand cmd,
        string? callerPaneId,
        CancellationToken ct)
    {
        var target = cmd.GetFlag("-t");
        var literal = cmd.HasFlag("-l");
        var sessionId = _targetResolver.ResolveToSessionId(target, callerPaneId);

        if (sessionId is null)
        {
            return TmuxResult.Fail("can't find pane\n");
        }

        if (cmd.Positional.Count == 0)
        {
            return TmuxResult.Ok();
        }

        var data = TmuxKeyTranslator.TranslateKeys(cmd.Positional, literal);
        await _sessionManager.SendInputAsync(sessionId, data, ct).ConfigureAwait(false);
        return TmuxResult.Ok();
    }

    /// <summary>
    /// Evaluate and return a tmux format string against session state.
    /// </summary>
    public TmuxResult DisplayMessage(TmuxCommandParser.ParsedCommand cmd, string? callerPaneId)
    {
        var target = cmd.GetFlag("-t");
        var sessionId = _targetResolver.ResolveToSessionId(target, callerPaneId);

        var message = cmd.Positional.Count > 0 ? cmd.Positional[0] : "";

        if (string.IsNullOrEmpty(message))
        {
            return TmuxResult.Ok("\n");
        }

        var sessions = _sessionManager.GetSessionList().Sessions;
        var session = sessions.FirstOrDefault(s => s.Id == sessionId) ?? sessions.FirstOrDefault();
        if (session is null)
        {
            return TmuxResult.Ok($"{message}\n");
        }

        var isActive = session.Id == _targetResolver.ResolveCallerSessionId(callerPaneId);
        var evaluated = _formatter.Evaluate(message, session, isActive);
        return TmuxResult.Ok($"{evaluated}\n");
    }

    /// <summary>
    /// Capture the terminal buffer contents from a pane. Supports -S/-E line range.
    /// </summary>
    public async Task<TmuxResult> CapturePaneAsync(
        TmuxCommandParser.ParsedCommand cmd,
        string? callerPaneId,
        CancellationToken ct)
    {
        var target = cmd.GetFlag("-t");
        var sessionId = _targetResolver.ResolveToSessionId(target, callerPaneId);

        if (sessionId is null)
        {
            return TmuxResult.Fail("can't find pane\n");
        }

        var buffer = await _sessionManager.GetBufferAsync(sessionId, ct).ConfigureAwait(false);
        if (buffer is null)
        {
            return TmuxResult.Fail("can't get buffer\n");
        }

        var text = Encoding.UTF8.GetString(buffer);

        var startStr = cmd.GetFlag("-S");
        var endStr = cmd.GetFlag("-E");

        if (startStr is not null || endStr is not null)
        {
            var lines = text.Split('\n');

            var startLine = 0;
            if (startStr is not null && int.TryParse(startStr, out var s))
            {
                startLine = s < 0 ? Math.Max(0, lines.Length + s) : s;
            }

            var endLine = lines.Length - 1;
            if (endStr is not null && int.TryParse(endStr, out var e))
            {
                endLine = e < 0 ? lines.Length + e : e;
            }

            startLine = Math.Clamp(startLine, 0, lines.Length - 1);
            endLine = Math.Clamp(endLine, startLine, lines.Length - 1);

            text = string.Join('\n', lines[startLine..(endLine + 1)]);
        }

        return TmuxResult.Ok(text);
    }
}
