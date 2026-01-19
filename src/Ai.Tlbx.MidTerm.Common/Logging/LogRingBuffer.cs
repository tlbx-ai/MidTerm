namespace Ai.Tlbx.MidTerm.Common.Logging;

/// <summary>
/// Thread-safe circular buffer that captures all log entries regardless of configured level.
/// When an error/exception occurs, the buffer is flushed to provide context.
/// </summary>
internal sealed class LogRingBuffer
{
    private const int Capacity = 1000;

    private readonly RingEntry[] _buffer = new RingEntry[Capacity];
    private readonly object _flushLock = new();
    private int _head;
    private int _count;

    /// <summary>
    /// Add an entry to the ring buffer. Lock-free for performance.
    /// </summary>
    internal void Add(LogSeverity level, string source, string message)
    {
        var timestamp = DateTime.Now;
        var index = Interlocked.Increment(ref _head) % Capacity;
        if (index < 0) index += Capacity;

        _buffer[index] = new RingEntry
        {
            Timestamp = timestamp,
            Level = level,
            Source = source,
            Message = message
        };

        if (_count < Capacity)
        {
            Interlocked.Increment(ref _count);
        }
    }

    /// <summary>
    /// Flush all buffered entries to the writer, then clear the buffer.
    /// Called when an error/exception is logged to provide context.
    /// </summary>
    internal void FlushTo(LogWriter writer, string source)
    {
        lock (_flushLock)
        {
            var count = Math.Min(_count, Capacity);
            if (count == 0)
            {
                return;
            }

            var entries = new List<RingEntry>(count);
            var head = _head % Capacity;
            if (head < 0) head += Capacity;

            var start = count < Capacity ? 0 : (head + 1) % Capacity;
            for (var i = 0; i < count; i++)
            {
                var idx = (start + i) % Capacity;
                var entry = _buffer[idx];
                if (entry.Message is not null)
                {
                    entries.Add(entry);
                }
            }

            if (entries.Count > 0)
            {
                entries.Sort((a, b) => a.Timestamp.CompareTo(b.Timestamp));

                writer.Write(LogSeverity.Info, source, $"--- CONTEXT ({entries.Count} entries) ---", immediateFlush: false);

                foreach (var entry in entries)
                {
                    writer.WriteRaw(entry.Timestamp, entry.Level, entry.Source, entry.Message);
                }

                writer.Write(LogSeverity.Info, source, "--- END CONTEXT ---", immediateFlush: false);
            }

            _count = 0;
            _head = -1;
            Array.Clear(_buffer);
        }
    }

    private struct RingEntry
    {
        public DateTime Timestamp;
        public LogSeverity Level;
        public string Source;
        public string Message;
    }
}
