using System.Text;

namespace Ai.Tlbx.MidTerm.Common.Protocol;

public sealed class SessionAgentAttachPoint
{
    public const string CodexProvider = "codex";
    public const string CodexAppServerWebSocketTransport = "codex.app-server.ws";

    public string Provider { get; set; } = string.Empty;
    public string TransportKind { get; set; } = string.Empty;
    public string Endpoint { get; set; } = string.Empty;
    public bool SharedRuntime { get; set; }
    public string Source { get; set; } = string.Empty;
    public string? PreferredThreadId { get; set; }
}

public static class SessionAgentAttachPointDetector
{
    public static SessionAgentAttachPoint? Detect(string? processName, string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            return null;
        }

        var tokens = Tokenize(commandLine);
        if (tokens.Count == 0)
        {
            return null;
        }

        if (!LooksLikeCodex(tokens[0], processName))
        {
            return null;
        }

        var remoteEndpoint = FindOptionValue(tokens, "--remote");
        if (TryCreateWebSocketAttachPoint(remoteEndpoint, source: "foreground-command-line.remote", out var remoteAttachPoint))
        {
            remoteAttachPoint.PreferredThreadId = TryDetectResumeThreadId(tokens);
            return remoteAttachPoint;
        }

        if (!tokens.Any(static token => string.Equals(token, "app-server", StringComparison.OrdinalIgnoreCase)))
        {
            return null;
        }

        var listenEndpoint = FindOptionValue(tokens, "--listen");
        return TryCreateWebSocketAttachPoint(listenEndpoint, source: "foreground-command-line.listen", out var listenAttachPoint)
            ? listenAttachPoint
            : null;
    }

    private static bool TryCreateWebSocketAttachPoint(string? candidate, string source, out SessionAgentAttachPoint attachPoint)
    {
        attachPoint = null!;
        if (string.IsNullOrWhiteSpace(candidate) ||
            !Uri.TryCreate(candidate, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeWs && uri.Scheme != Uri.UriSchemeWss))
        {
            return false;
        }

        attachPoint = new SessionAgentAttachPoint
        {
            Provider = SessionAgentAttachPoint.CodexProvider,
            TransportKind = SessionAgentAttachPoint.CodexAppServerWebSocketTransport,
            Endpoint = uri.ToString(),
            SharedRuntime = true,
            Source = source
        };
        return true;
    }

    private static bool LooksLikeCodex(string executableToken, string? processName)
    {
        if (IsCodexName(processName))
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(executableToken))
        {
            return false;
        }

        var trimmed = executableToken.Trim().Trim('"', '\'');
        var fileName = Path.GetFileNameWithoutExtension(trimmed);
        return IsCodexName(fileName);
    }

    private static bool IsCodexName(string? value)
    {
        return string.Equals(value, "codex", StringComparison.OrdinalIgnoreCase);
    }

    private static string? TryDetectResumeThreadId(IReadOnlyList<string> tokens)
    {
        for (var i = 0; i < tokens.Count; i++)
        {
            if (!string.Equals(tokens[i], "resume", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            for (var j = i + 1; j < tokens.Count; j++)
            {
                var candidate = tokens[j];
                if (candidate.StartsWith("-", StringComparison.Ordinal))
                {
                    continue;
                }

                return candidate;
            }
        }

        return null;
    }

    private static string? FindOptionValue(IReadOnlyList<string> tokens, string optionName)
    {
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (string.Equals(token, optionName, StringComparison.OrdinalIgnoreCase))
            {
                return i + 1 < tokens.Count ? tokens[i + 1] : null;
            }

            var prefix = optionName + "=";
            if (token.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return token[prefix.Length..];
            }
        }

        return null;
    }

    private static List<string> Tokenize(string commandLine)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        char? quote = null;

        for (var i = 0; i < commandLine.Length; i++)
        {
            var ch = commandLine[i];
            if (quote is not null)
            {
                if (ch == quote.Value)
                {
                    quote = null;
                    continue;
                }

                if (ch == '\\' &&
                    i + 1 < commandLine.Length &&
                    commandLine[i + 1] == quote.Value)
                {
                    current.Append(commandLine[i + 1]);
                    i++;
                    continue;
                }

                current.Append(ch);
                continue;
            }

            if (ch is '"' or '\'')
            {
                quote = ch;
                continue;
            }

            if (char.IsWhiteSpace(ch))
            {
                FlushCurrent(tokens, current);
                continue;
            }

            current.Append(ch);
        }

        FlushCurrent(tokens, current);
        return tokens;
    }

    private static void FlushCurrent(List<string> tokens, StringBuilder current)
    {
        if (current.Length == 0)
        {
            return;
        }

        tokens.Add(current.ToString());
        current.Clear();
    }
}
