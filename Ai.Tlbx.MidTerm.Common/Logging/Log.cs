namespace Ai.Tlbx.MidTerm.Common.Logging;

public static class Log
{
    private static Logger? _instance;
    private static readonly object _lock = new();

    public static LogSeverity MinLevel
    {
        get => _instance?.MinLevel ?? LogSeverity.Warn;
        set
        {
            if (_instance is not null)
            {
                _instance.MinLevel = value;
            }
        }
    }

    public static bool IsEnabled(LogSeverity level) => level <= MinLevel;

    public static void Initialize(string source, string logDirectory, LogSeverity minLevel = LogSeverity.Warn, LogRotationPolicy? policy = null)
    {
        lock (_lock)
        {
            _instance?.Dispose();
            _instance = new Logger(source, logDirectory, policy);
            _instance.MinLevel = minLevel;
        }
    }

    public static void Shutdown()
    {
        lock (_lock)
        {
            _instance?.Dispose();
            _instance = null;
        }
    }

    public static void Exception(Exception ex, string context)
    {
        _instance?.Exception(ex, context);
    }

    public static void Error(Func<string> messageFactory)
    {
        _instance?.Error(messageFactory);
    }

    public static void Warn(Func<string> messageFactory)
    {
        _instance?.Warn(messageFactory);
    }

    public static void Info(Func<string> messageFactory)
    {
        _instance?.Info(messageFactory);
    }

    public static void Verbose(Func<string> messageFactory)
    {
        _instance?.Verbose(messageFactory);
    }
}
