using System.Text;
using System.Threading.Channels;

namespace Ai.Tlbx.MidTerm.Common.Logging;

internal sealed class LogWriter : IDisposable
{
    private const int MaxQueuedEntries = 10_000;
    private const int BufferSizeBytes = 65536;
    private const int FlushIntervalMs = 100;
    private const int PeriodicCleanupIntervalMs = 60 * 60 * 1000; // 1 hour

    private readonly Channel<LogEntry> _queue;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _writerTask;
    private readonly Timer _cleanupTimer;
    private readonly string _logDirectory;
    private readonly string _filePrefix;
    private readonly LogRotationPolicy _policy;
    private readonly string _startTimestamp;

    private FileStream? _currentFile;
    private StreamWriter? _currentWriter;
    private string? _currentFilePath;
    private long _currentFileSize;

    public LogWriter(string filePrefix, string logDirectory, LogRotationPolicy policy)
    {
        _filePrefix = filePrefix;
        _logDirectory = logDirectory;
        _policy = policy;
        _startTimestamp = DateTime.Now.ToString("yyyy-MM-dd-HHmmss");

        _queue = Channel.CreateBounded<LogEntry>(new BoundedChannelOptions(MaxQueuedEntries)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        });

        _writerTask = ProcessQueueAsync(_cts.Token);

        // Startup cleanup on low-priority background thread (don't block launch)
        ThreadPool.QueueUserWorkItem(_ => EnforceDirectorySizeLimit(), null);

        // Periodic cleanup for long-running processes
        _cleanupTimer = new Timer(_ => EnforceDirectorySizeLimit(), null,
            PeriodicCleanupIntervalMs, PeriodicCleanupIntervalMs);
    }

    public void Write(LogSeverity level, string source, string message, bool immediateFlush)
    {
        if (_cts.IsCancellationRequested)
        {
            return;
        }

        var entry = new LogEntry
        {
            Timestamp = DateTime.Now,
            Level = level,
            Source = source,
            Message = message,
            ImmediateFlush = immediateFlush
        };

        _queue.Writer.TryWrite(entry);
    }

    private async Task ProcessQueueAsync(CancellationToken ct)
    {
        var buffer = new StringBuilder(BufferSizeBytes);
        var lastFlush = DateTime.UtcNow;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var needsImmediateFlush = false;

                // Use TryRead with Task.Delay instead of linked CTS to avoid allocations
                var hasData = _queue.Reader.TryRead(out var firstEntry);
                if (!hasData)
                {
                    // Wait for data or timeout, whichever comes first
                    var waitTask = _queue.Reader.WaitToReadAsync(ct).AsTask();
                    var delayTask = Task.Delay(FlushIntervalMs, ct);

                    var completedTask = await Task.WhenAny(waitTask, delayTask).ConfigureAwait(false);

                    if (completedTask == waitTask && await waitTask.ConfigureAwait(false))
                    {
                        hasData = _queue.Reader.TryRead(out firstEntry);
                    }
                }

                if (hasData)
                {
                    FormatEntry(buffer, firstEntry);
                    needsImmediateFlush |= firstEntry.ImmediateFlush;

                    // Drain all available entries
                    while (_queue.Reader.TryRead(out var entry))
                    {
                        FormatEntry(buffer, entry);
                        needsImmediateFlush |= entry.ImmediateFlush;

                        if (buffer.Length >= BufferSizeBytes)
                        {
                            await FlushBufferAsync(buffer).ConfigureAwait(false);
                            lastFlush = DateTime.UtcNow;
                        }
                    }
                }

                if (needsImmediateFlush ||
                    (buffer.Length > 0 && (DateTime.UtcNow - lastFlush).TotalMilliseconds >= FlushIntervalMs))
                {
                    await FlushBufferAsync(buffer).ConfigureAwait(false);
                    lastFlush = DateTime.UtcNow;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            while (_queue.Reader.TryRead(out var entry))
            {
                FormatEntry(buffer, entry);
            }

            if (buffer.Length > 0)
            {
                try
                {
                    await FlushBufferAsync(buffer).ConfigureAwait(false);
                }
                catch
                {
                }
            }

            CloseCurrentFile();
        }
    }

    private static void FormatEntry(StringBuilder buffer, LogEntry entry)
    {
        buffer.Append('[');
        buffer.Append(entry.Timestamp.ToString("yyyy-MM-dd HH:mm:ss.fff"));
        buffer.Append("] [");
        buffer.Append(GetLevelString(entry.Level));
        buffer.Append("] [");
        buffer.Append(entry.Source);
        buffer.Append("] ");
        buffer.AppendLine(entry.Message);
    }

    private static string GetLevelString(LogSeverity level) => level switch
    {
        LogSeverity.Exception => "EXCEPTION",
        LogSeverity.Error => "ERROR",
        LogSeverity.Warn => "WARN",
        LogSeverity.Info => "INFO",
        LogSeverity.Verbose => "VERBOSE",
        _ => "UNKNOWN"
    };

    private async Task FlushBufferAsync(StringBuilder buffer)
    {
        if (buffer.Length == 0)
        {
            return;
        }

        try
        {
            EnsureFileOpen();
            RotateIfNeeded();

            var text = buffer.ToString();
            buffer.Clear();

            await _currentWriter!.WriteAsync(text).ConfigureAwait(false);
            await _currentWriter.FlushAsync().ConfigureAwait(false);
            _currentFileSize += Encoding.UTF8.GetByteCount(text);
        }
        catch
        {
        }
    }

    private void EnsureFileOpen()
    {
        if (_currentFile is not null)
        {
            return;
        }

        Directory.CreateDirectory(_logDirectory);
        _currentFilePath = Path.Combine(_logDirectory, $"{_filePrefix}-{_startTimestamp}.log");

        _currentFile = new FileStream(
            _currentFilePath,
            FileMode.Append,
            FileAccess.Write,
            FileShare.ReadWrite | FileShare.Delete,
            bufferSize: 4096,
            useAsync: true);

        _currentWriter = new StreamWriter(_currentFile, Encoding.UTF8, leaveOpen: false);
        _currentFileSize = _currentFile.Length;
    }

    private void RotateIfNeeded()
    {
        if (_currentFileSize < _policy.MaxFileSizeBytes)
        {
            return;
        }

        CloseCurrentFile();

        var basePath = Path.Combine(_logDirectory, $"{_filePrefix}-{_startTimestamp}");

        for (var i = _policy.MaxFileCount - 1; i >= 1; i--)
        {
            var src = i == 1 ? $"{basePath}.log" : $"{basePath}.{i - 1}.log";
            var dst = $"{basePath}.{i}.log";

            if (File.Exists(src))
            {
                try
                {
                    File.Move(src, dst, overwrite: true);
                }
                catch
                {
                }
            }
        }

        EnsureFileOpen();
        EnforceDirectorySizeLimit();
    }

    private void EnforceDirectorySizeLimit()
    {
        try
        {
            var files = Directory.GetFiles(_logDirectory, "*.log")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .ToList();

            var totalSize = files.Sum(f => f.Length);

            while (totalSize > _policy.MaxDirectorySizeBytes && files.Count > 1)
            {
                var oldest = files[^1];
                totalSize -= oldest.Length;

                try
                {
                    oldest.Delete();
                }
                catch
                {
                }

                files.RemoveAt(files.Count - 1);
            }
        }
        catch
        {
        }
    }

    private void CloseCurrentFile()
    {
        _currentWriter?.Dispose();
        _currentFile?.Dispose();
        _currentWriter = null;
        _currentFile = null;
        _currentFilePath = null;
        _currentFileSize = 0;
    }

    public void Dispose()
    {
        _cleanupTimer.Dispose();
        _queue.Writer.Complete();
        _cts.Cancel();

        try
        {
            _writerTask.Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
        }

        _cts.Dispose();
    }

    private readonly struct LogEntry
    {
        public DateTime Timestamp { get; init; }
        public LogSeverity Level { get; init; }
        public string Source { get; init; }
        public string Message { get; init; }
        public bool ImmediateFlush { get; init; }
    }
}
