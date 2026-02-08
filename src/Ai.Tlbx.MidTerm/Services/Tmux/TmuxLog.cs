using System.Text;
using System.Text.RegularExpressions;

namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Dedicated tmux log that always writes to tmux.log regardless of global log severity.
/// Logs every command received and the result, for debugging the compatibility layer.
/// All output is sanitized to strip ANSI escape sequences and control characters.
/// </summary>
public static partial class TmuxLog
{
    private static StreamWriter? _writer;
    private static readonly object _lock = new();
    private const int MaxResultLength = 500;

    [GeneratedRegex(@"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|\([AB012])")]
    private static partial Regex AnsiEscapePattern();

    public static void Initialize(string logDirectory)
    {
        lock (_lock)
        {
            try
            {
                Directory.CreateDirectory(logDirectory);
                var path = Path.Combine(logDirectory, "tmux.log");
                _writer = new StreamWriter(path, append: true) { AutoFlush = true };
                Write("TmuxLog initialized");
            }
            catch
            {
                // Best-effort — don't break startup if we can't create the log
            }
        }
    }

    public static void RawArgs(List<string> args, string? callerPaneId)
    {
        var pane = callerPaneId ?? "?";
        var sanitized = args.Select(Sanitize);
        Write($"[pane={pane}] args: [{string.Join(", ", sanitized.Select(a => $"\"{a}\""))}]");
    }

    public static void Command(string name, string? callerPaneId, Dictionary<string, string?> flags, List<string> positional)
    {
        var parts = new List<string> { name };

        foreach (var (key, value) in flags)
        {
            parts.Add(value is null ? key : $"{key} {Sanitize(value)}");
        }

        foreach (var p in positional)
        {
            parts.Add(Sanitize(p));
        }

        var pane = callerPaneId ?? "?";
        Write($"[pane={pane}] >> {string.Join(" ", parts)}");
    }

    public static void Result(string name, bool success, string output)
    {
        var status = success ? "OK" : "FAIL";
        var sanitized = Sanitize(output).TrimEnd('\n', '\r');

        if (string.IsNullOrEmpty(sanitized))
        {
            Write($"   << {status}");
            return;
        }

        if (sanitized.Length > MaxResultLength)
        {
            sanitized = sanitized[..MaxResultLength] + $"... ({sanitized.Length} chars total)";
        }

        Write($"   << {status}: {sanitized}");
    }

    public static void Error(string message)
    {
        Write($"   !! {message}");
    }

    public static void Shutdown()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _writer = null;
        }
    }

    private static string Sanitize(string input)
    {
        var withoutEscapes = AnsiEscapePattern().Replace(input, "");
        var sb = new StringBuilder(withoutEscapes.Length);
        foreach (var c in withoutEscapes)
        {
            if (c == '\n' || c == '\r' || c == '\t')
            {
                sb.Append(c switch { '\n' => "\\n", '\r' => "\\r", _ => "\\t" });
            }
            else if (char.IsControl(c))
            {
                sb.Append($"\\x{(int)c:X2}");
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    private static void Write(string message)
    {
        lock (_lock)
        {
            _writer?.WriteLine($"{DateTime.UtcNow:HH:mm:ss.fff} {message}");
        }
    }
}
