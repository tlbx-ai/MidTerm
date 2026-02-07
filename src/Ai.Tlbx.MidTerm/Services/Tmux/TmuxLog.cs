namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Dedicated tmux log that always writes to tmux.log regardless of global log severity.
/// Logs every command received and the result, for debugging the compatibility layer.
/// </summary>
public static class TmuxLog
{
    private static StreamWriter? _writer;
    private static readonly object _lock = new();

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

    public static void Command(string name, string? callerPaneId, Dictionary<string, string?> flags, List<string> positional)
    {
        var parts = new List<string> { name };

        foreach (var (key, value) in flags)
        {
            parts.Add(value is null ? key : $"{key} {value}");
        }

        foreach (var p in positional)
        {
            parts.Add(p);
        }

        var pane = callerPaneId ?? "?";
        Write($"[pane={pane}] >> {string.Join(" ", parts)}");
    }

    public static void Result(string name, bool success, string output)
    {
        var status = success ? "OK" : "FAIL";
        var trimmed = output.TrimEnd('\n', '\r');
        if (string.IsNullOrEmpty(trimmed))
        {
            Write($"   << {status}");
        }
        else
        {
            Write($"   << {status}: {trimmed}");
        }
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

    private static void Write(string message)
    {
        lock (_lock)
        {
            _writer?.WriteLine($"{DateTime.UtcNow:HH:mm:ss.fff} {message}");
        }
    }
}
