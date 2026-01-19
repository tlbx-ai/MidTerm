using System.Runtime.CompilerServices;

namespace Ai.Tlbx.MidTerm.Common.Logging;

public sealed class Logger : IDisposable
{
    private const int ContextDumpCooldownSeconds = 30;

    private readonly string _source;
    private readonly LogWriter _writer;
    private readonly LogRingBuffer _ringBuffer = new();
    private LogSeverity _minLevel = LogSeverity.Warn;
    private DateTime _lastContextDump = DateTime.MinValue;

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
        // Only evaluate message if we'll use it (level passes OR ring buffer capture)
        // Ring buffer only captures Info and above to avoid verbose spam
        var captureInRingBuffer = level <= LogSeverity.Info;
        var passesFilter = level <= _minLevel;

        if (!captureInRingBuffer && !passesFilter)
        {
            return;
        }

        var message = messageFactory();

        if (captureInRingBuffer)
        {
            _ringBuffer.Add(level, _source, message);
        }

        if (!passesFilter)
        {
            return;
        }

        _writer.Write(level, _source, message, immediateFlush: false);
    }

    public void Exception(Exception ex, string context)
    {
        var message = $"[{context}] {ex.GetType().Name}: {ex.Message}\n  StackTrace: {ex.StackTrace}";

        if (ex.InnerException is not null)
        {
            message += $"\n  Inner: {ex.InnerException.GetType().Name}: {ex.InnerException.Message}";
        }

        _ringBuffer.Add(LogSeverity.Exception, _source, message);

        if (LogSeverity.Exception > _minLevel)
        {
            return;
        }

        // Flush context on exception, with cooldown to prevent spam
        var now = DateTime.UtcNow;
        if ((now - _lastContextDump).TotalSeconds >= ContextDumpCooldownSeconds)
        {
            _ringBuffer.FlushTo(_writer, _source);
            _lastContextDump = now;
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
