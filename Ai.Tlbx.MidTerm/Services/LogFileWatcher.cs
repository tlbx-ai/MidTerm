using System.Buffers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Watches log files for new entries using polling.
/// Optimized for low allocations and multiple concurrent subscribers.
/// </summary>
public sealed partial class LogFileWatcher : IDisposable
{
    private readonly string _logDirectory;
    private readonly ConcurrentDictionary<string, FileWatchState> _fileStates = new();
    private readonly Timer _pollTimer;
    private readonly ConcurrentDictionary<string, Action<LogEntryMessage>> _subscribers = new();
    private readonly byte[] _readBuffer = new byte[65536];
    private readonly object _pollLock = new();
    private bool _polling;
    private bool _disposed;

    public LogFileWatcher(string logDirectory, TimeSpan pollInterval)
    {
        _logDirectory = logDirectory;
        _pollTimer = new Timer(PollFiles, null, pollInterval, pollInterval);
    }

    /// <summary>
    /// Subscribe to log entries. Returns subscription ID.
    /// </summary>
    public string Subscribe(Action<LogEntryMessage> callback)
    {
        var id = Guid.NewGuid().ToString("N");
        _subscribers[id] = callback;
        return id;
    }

    /// <summary>
    /// Unsubscribe from log entries.
    /// </summary>
    public void Unsubscribe(string subscriptionId)
    {
        _subscribers.TryRemove(subscriptionId, out _);
    }

    private void PollFiles(object? state)
    {
        if (_disposed || _subscribers.IsEmpty) return;

        // Prevent overlapping polls if previous poll is slow
        lock (_pollLock)
        {
            if (_polling) return;
            _polling = true;
        }

        try
        {
            if (!Directory.Exists(_logDirectory)) return;

            var currentFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var filePath in Directory.EnumerateFiles(_logDirectory, "*.log"))
            {
                currentFiles.Add(filePath);
                ProcessFile(filePath);
            }

            // Clean up stale file states for deleted/rotated files
            foreach (var staleKey in _fileStates.Keys.Where(k => !currentFiles.Contains(k)).ToList())
            {
                _fileStates.TryRemove(staleKey, out _);
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[LogFileWatcher] Poll error: {ex.Message}");
        }
        finally
        {
            lock (_pollLock)
            {
                _polling = false;
            }
        }
    }

    private void ProcessFile(string filePath)
    {
        try
        {
            var fileName = Path.GetFileName(filePath);
            var fileState = _fileStates.GetOrAdd(filePath, _ => new FileWatchState());

            // Quick check without opening file
            var fileInfo = new FileInfo(filePath);
            if (!fileInfo.Exists) return;

            var currentLength = fileInfo.Length;
            if (currentLength == fileState.Position) return;

            // Parse source/sessionId once per file, cache in state
            if (fileState.Source is null)
            {
                fileState.Source = fileName.StartsWith("mt-", StringComparison.OrdinalIgnoreCase) ? "mt" : "mthost";
                if (fileState.Source == "mthost")
                {
                    var match = MtHostLogRegex().Match(fileName);
                    fileState.SessionId = match.Success ? match.Groups[1].Value : null;
                }
            }

            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, bufferSize: 4096, FileOptions.SequentialScan);

            // Handle file truncation/rotation
            if (currentLength < fileState.Position)
            {
                fileState.Position = 0;
            }

            if (currentLength == fileState.Position) return;

            fs.Seek(fileState.Position, SeekOrigin.Begin);

            // Read in chunks, parse lines manually to minimize allocations
            int bytesRead;
            while ((bytesRead = fs.Read(_readBuffer, 0, _readBuffer.Length)) > 0)
            {
                ProcessBuffer(_readBuffer.AsSpan(0, bytesRead), fileState);
            }

            fileState.Position = fs.Position;
        }
        catch (IOException)
        {
            // File may be locked or deleted
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[LogFileWatcher] Error reading {filePath}: {ex.Message}");
        }
    }

    private void ProcessBuffer(ReadOnlySpan<byte> buffer, FileWatchState state)
    {
        var lineBuilder = state.LineBuilder;
        var start = 0;
        for (var i = 0; i < buffer.Length; i++)
        {
            if (buffer[i] == '\n')
            {
                var lineEnd = i;
                if (lineEnd > start && buffer[lineEnd - 1] == '\r')
                {
                    lineEnd--;
                }

                if (lineEnd > start)
                {
                    lineBuilder.Append(Encoding.UTF8.GetString(buffer.Slice(start, lineEnd - start)));
                }

                if (lineBuilder.Length > 0)
                {
                    ProcessLine(lineBuilder.ToString(), state);
                    lineBuilder.Clear();
                }
                start = i + 1;
            }
        }

        // Save partial line for next buffer/poll
        if (start < buffer.Length)
        {
            lineBuilder.Append(Encoding.UTF8.GetString(buffer.Slice(start)));
        }
    }

    private void ProcessLine(string line, FileWatchState state)
    {
        if (string.IsNullOrWhiteSpace(line)) return;

        var entry = ParseLogLine(line, state.Source!, state.SessionId);
        if (entry is null) return;

        // Broadcast to all subscribers (fire-and-forget, non-blocking)
        foreach (var subscriber in _subscribers.Values)
        {
            try
            {
                subscriber(entry);
            }
            catch
            {
                // Don't let one bad subscriber break others
            }
        }
    }

    /// <summary>
    /// Get recent log entries. Called on-demand, not on poll path.
    /// </summary>
    public List<LogEntryMessage> GetRecentEntries(string source, string? sessionId, int limit)
    {
        var entries = new List<LogEntryMessage>(Math.Min(limit, 256));

        try
        {
            if (!Directory.Exists(_logDirectory)) return entries;

            var pattern = source == "mt" ? "mt-*.log" : $"mthost-{sessionId ?? "*"}-*.log";

            // Get files sorted by write time without creating FileInfo for each
            var files = Directory.EnumerateFiles(_logDirectory, pattern)
                .Select(f => (Path: f, Time: File.GetLastWriteTimeUtc(f)))
                .OrderByDescending(f => f.Time)
                .Take(3)
                .Select(f => f.Path);

            foreach (var file in files)
            {
                ReadFileEntries(file, source, sessionId, entries, limit);
                if (entries.Count >= limit) break;
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[LogFileWatcher] GetRecentEntries error: {ex.Message}");
        }

        // Return most recent entries in chronological order
        if (entries.Count > limit)
        {
            entries = entries.TakeLast(limit).ToList();
        }
        return entries;
    }

    private void ReadFileEntries(string filePath, string source, string? sessionId,
        List<LogEntryMessage> entries, int limit)
    {
        string? fileSessionId = null;
        if (source == "mthost")
        {
            var match = MtHostLogRegex().Match(Path.GetFileName(filePath));
            fileSessionId = match.Success ? match.Groups[1].Value : sessionId;
        }

        try
        {
            using var fs = new FileStream(filePath, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, bufferSize: 4096, FileOptions.SequentialScan);
            using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: false,
                bufferSize: 4096, leaveOpen: true);

            while (!reader.EndOfStream && entries.Count < limit * 2) // Read extra for sorting
            {
                var line = reader.ReadLine();
                if (string.IsNullOrWhiteSpace(line)) continue;

                var entry = ParseLogLine(line, source, fileSessionId);
                if (entry is not null)
                {
                    entries.Add(entry);
                }
            }
        }
        catch (IOException)
        {
            // File may be locked
        }
    }

    /// <summary>
    /// Get list of sessions that have log files.
    /// </summary>
    public List<LogSessionInfo> GetLogSessions(IReadOnlyList<string> activeSessions)
    {
        var sessions = new List<LogSessionInfo>();
        var activeSet = new HashSet<string>(activeSessions);
        var sessionIds = new HashSet<string>();

        try
        {
            if (!Directory.Exists(_logDirectory)) return sessions;

            foreach (var file in Directory.EnumerateFiles(_logDirectory, "mthost-*.log"))
            {
                var match = MtHostLogRegex().Match(Path.GetFileName(file));
                if (match.Success)
                {
                    sessionIds.Add(match.Groups[1].Value);
                }
            }

            foreach (var sessionId in sessionIds)
            {
                // Estimate log count from cached state instead of reading files
                var logCount = EstimateLogCount(sessionId);
                sessions.Add(new LogSessionInfo
                {
                    Id = sessionId,
                    Active = activeSet.Contains(sessionId),
                    LogCount = logCount
                });
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[LogFileWatcher] GetLogSessions error: {ex.Message}");
        }

        return sessions
            .OrderByDescending(s => s.Active)
            .ThenBy(s => s.Id)
            .ToList();
    }

    private int EstimateLogCount(string sessionId)
    {
        // Estimate based on file sizes rather than reading all content
        var totalBytes = 0L;
        try
        {
            foreach (var file in Directory.EnumerateFiles(_logDirectory, $"mthost-{sessionId}-*.log"))
            {
                totalBytes += new FileInfo(file).Length;
            }
        }
        catch
        {
            return 0;
        }

        // Rough estimate: ~100 bytes per log line
        return (int)(totalBytes / 100);
    }

    private static LogEntryMessage? ParseLogLine(string line, string source, string? sessionId)
    {
        // Format: [2024-01-15 10:30:45.123] [WARN] [mt] WebSocket connection lost
        var match = LogLineRegex().Match(line);
        if (!match.Success) return null;

        return new LogEntryMessage
        {
            MessageType = "log",
            Source = source,
            SessionId = sessionId,
            Timestamp = match.Groups[1].Value,
            Level = match.Groups[2].ValueSpan.ToString().ToLowerInvariant(),
            Message = match.Groups[3].Value
        };
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _pollTimer.Dispose();
        _subscribers.Clear();
    }

    [GeneratedRegex(@"^mthost-([a-f0-9]+)-", RegexOptions.IgnoreCase | RegexOptions.Compiled)]
    private static partial Regex MtHostLogRegex();

    [GeneratedRegex(@"^\[([^\]]+)\] \[([^\]]+)\] \[[^\]]+\] (.+)$", RegexOptions.Compiled)]
    private static partial Regex LogLineRegex();

    private sealed class FileWatchState
    {
        public long Position;
        public string? Source;
        public string? SessionId;
        public readonly StringBuilder LineBuilder = new(1024);
    }
}
