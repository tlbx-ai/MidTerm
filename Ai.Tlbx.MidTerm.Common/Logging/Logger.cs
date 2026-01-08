using System.Runtime.CompilerServices;

namespace Ai.Tlbx.MidTerm.Common.Logging;

public sealed class Logger : IDisposable
{
    private readonly string _source;
    private readonly LogWriter _writer;
    private LogSeverity _minLevel = LogSeverity.Warn;

    public LogSeverity MinLevel
    {
        get => _minLevel;
        set => _minLevel = value;
    }

    public Logger(string source, string logDirectory, LogRotationPolicy? policy = null)
    {
        _source = source;
        _writer = new LogWriter(source, logDirectory, policy ?? LogRotationPolicy.Default);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Log(LogSeverity level, Func<string> messageFactory)
    {
        if (level > _minLevel)
        {
            return;
        }

        var message = messageFactory();
        _writer.Write(level, _source, message, immediateFlush: level == LogSeverity.Exception);
    }

    public void Exception(Exception ex, string context)
    {
        if (LogSeverity.Exception > _minLevel)
        {
            return;
        }

        var message = $"[{context}] {ex.GetType().Name}: {ex.Message}\n  StackTrace: {ex.StackTrace}";

        if (ex.InnerException is not null)
        {
            message += $"\n  Inner: {ex.InnerException.GetType().Name}: {ex.InnerException.Message}";
        }

        _writer.Write(LogSeverity.Exception, _source, message, immediateFlush: true);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Error(Func<string> messageFactory) => Log(LogSeverity.Error, messageFactory);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Warn(Func<string> messageFactory) => Log(LogSeverity.Warn, messageFactory);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Info(Func<string> messageFactory) => Log(LogSeverity.Info, messageFactory);

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public void Verbose(Func<string> messageFactory) => Log(LogSeverity.Verbose, messageFactory);

    public void Dispose()
    {
        _writer.Dispose();
    }
}
