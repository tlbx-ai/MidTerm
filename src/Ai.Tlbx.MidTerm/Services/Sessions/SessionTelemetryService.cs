using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionTelemetryService
{
    private const int MaxBucketCount = 900;
    private const int MaxBellEventCount = 200;

    private sealed class OutputBucket
    {
        public long UnixSecond { get; init; }
        public int Bytes { get; set; }
    }

    private sealed class BellRecord
    {
        public DateTimeOffset Timestamp { get; init; }
        public int Count { get; init; }
    }

    private sealed class SessionTelemetryState
    {
        public Lock SyncRoot { get; } = new();
        public List<OutputBucket> Buckets { get; } = [];
        public List<BellRecord> BellRecords { get; } = [];
        public long TotalOutputBytes { get; set; }
        public long TotalInputBytes { get; set; }
        public int TotalBellCount { get; set; }
        public DateTimeOffset? LastInputAt { get; set; }
        public DateTimeOffset? LastOutputAt { get; set; }
        public DateTimeOffset? LastBellAt { get; set; }
    }

    private readonly ConcurrentDictionary<string, SessionTelemetryState> _sessions = new();

    public void RecordOutput(string sessionId, ReadOnlySpan<byte> data)
    {
        var state = _sessions.GetOrAdd(sessionId, _ => new SessionTelemetryState());
        var now = DateTimeOffset.UtcNow;
        var unixSecond = now.ToUnixTimeSeconds();
        var bellCount = TerminalOutputSanitizer.CountBellEvents(data);

        lock (state.SyncRoot)
        {
            state.TotalOutputBytes += data.Length;
            state.LastOutputAt = now;
            AddBytes(state, unixSecond, data.Length);

            if (bellCount > 0)
            {
                state.TotalBellCount += bellCount;
                state.LastBellAt = now;
                state.BellRecords.Add(new BellRecord
                {
                    Timestamp = now,
                    Count = bellCount
                });
                TrimBells(state);
            }
        }
    }

    public void RecordInput(string sessionId, int byteCount)
    {
        var state = _sessions.GetOrAdd(sessionId, _ => new SessionTelemetryState());
        var now = DateTimeOffset.UtcNow;

        lock (state.SyncRoot)
        {
            state.TotalInputBytes += byteCount;
            state.LastInputAt = now;
        }
    }

    public void ClearSession(string sessionId)
    {
        _sessions.TryRemove(sessionId, out _);
    }

    public SessionActivityResponse GetActivity(string sessionId, int seconds, int bellLimit)
    {
        seconds = Math.Clamp(seconds, 10, MaxBucketCount);
        bellLimit = Math.Clamp(bellLimit, 1, MaxBellEventCount);
        var nowSecond = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var startSecond = nowSecond - seconds + 1;

        var response = new SessionActivityResponse
        {
            SessionId = sessionId,
            WindowSeconds = seconds,
            BellLimit = bellLimit
        };

        if (!_sessions.TryGetValue(sessionId, out var state))
        {
            AppendEmptyHeatmap(response, startSecond, nowSecond);
            return response;
        }

        lock (state.SyncRoot)
        {
            TrimBuckets(state, nowSecond);
            TrimBells(state);

            response.TotalOutputBytes = state.TotalOutputBytes;
            response.TotalBellCount = state.TotalBellCount;
            response.LastOutputAt = state.LastOutputAt;
            response.LastBellAt = state.LastBellAt;

            var bytesBySecond = new Dictionary<long, int>(seconds);
            foreach (var bucket in state.Buckets)
            {
                if (bucket.UnixSecond >= startSecond)
                {
                    bytesBySecond[bucket.UnixSecond] = bucket.Bytes;
                }
            }

            var maxBytes = 0;
            for (var second = startSecond; second <= nowSecond; second++)
            {
                if (bytesBySecond.TryGetValue(second, out var bytes) && bytes > maxBytes)
                {
                    maxBytes = bytes;
                }
            }

            for (var second = startSecond; second <= nowSecond; second++)
            {
                var bytes = bytesBySecond.TryGetValue(second, out var value) ? value : 0;
                var heat = maxBytes > 0 ? Math.Round(bytes / (double)maxBytes, 4) : 0;

                response.Heatmap.Add(new SessionActivityHeatSample
                {
                    Timestamp = DateTimeOffset.FromUnixTimeSeconds(second),
                    Bytes = bytes,
                    Heat = heat
                });
            }

            response.CurrentBytesPerSecond = response.Heatmap.Count > 0
                ? response.Heatmap[^1].Bytes
                : 0;
            response.CurrentHeat = response.Heatmap.Count > 0
                ? response.Heatmap[^1].Heat
                : 0;

            foreach (var bell in state.BellRecords.TakeLast(bellLimit))
            {
                response.BellHistory.Add(new SessionBellEvent
                {
                    Timestamp = bell.Timestamp,
                    Count = bell.Count
                });
            }
        }

        return response;
    }

    public SessionTelemetrySnapshot GetSnapshot(string sessionId, int seconds = 120)
    {
        seconds = Math.Clamp(seconds, 10, MaxBucketCount);
        var nowSecond = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var startSecond = nowSecond - seconds + 1;

        if (!_sessions.TryGetValue(sessionId, out var state))
        {
            return new SessionTelemetrySnapshot();
        }

        lock (state.SyncRoot)
        {
            TrimBuckets(state, nowSecond);
            TrimBells(state);

            var maxBytes = 0;
            var currentBytes = 0;
            foreach (var bucket in state.Buckets)
            {
                if (bucket.UnixSecond < startSecond)
                {
                    continue;
                }

                if (bucket.Bytes > maxBytes)
                {
                    maxBytes = bucket.Bytes;
                }

                if (bucket.UnixSecond == nowSecond)
                {
                    currentBytes = bucket.Bytes;
                }
            }

            return new SessionTelemetrySnapshot
            {
                TotalOutputBytes = state.TotalOutputBytes,
                TotalInputBytes = state.TotalInputBytes,
                TotalBellCount = state.TotalBellCount,
                LastInputAt = state.LastInputAt,
                LastOutputAt = state.LastOutputAt,
                LastBellAt = state.LastBellAt,
                CurrentBytesPerSecond = currentBytes,
                CurrentHeat = maxBytes > 0 ? Math.Round(currentBytes / (double)maxBytes, 4) : 0
            };
        }
    }

    private static void AddBytes(SessionTelemetryState state, long unixSecond, int bytes)
    {
        if (state.Buckets.Count > 0 && state.Buckets[^1].UnixSecond == unixSecond)
        {
            state.Buckets[^1].Bytes += bytes;
            return;
        }

        state.Buckets.Add(new OutputBucket
        {
            UnixSecond = unixSecond,
            Bytes = bytes
        });
        TrimBuckets(state, unixSecond);
    }

    private static void TrimBuckets(SessionTelemetryState state, long currentUnixSecond)
    {
        var minSecond = currentUnixSecond - MaxBucketCount + 1;
        while (state.Buckets.Count > 0 && state.Buckets[0].UnixSecond < minSecond)
        {
            state.Buckets.RemoveAt(0);
        }
    }

    private static void TrimBells(SessionTelemetryState state)
    {
        while (state.BellRecords.Count > MaxBellEventCount)
        {
            state.BellRecords.RemoveAt(0);
        }
    }

    private static void AppendEmptyHeatmap(SessionActivityResponse response, long startSecond, long nowSecond)
    {
        for (var second = startSecond; second <= nowSecond; second++)
        {
            response.Heatmap.Add(new SessionActivityHeatSample
            {
                Timestamp = DateTimeOffset.FromUnixTimeSeconds(second),
                Bytes = 0,
                Heat = 0
            });
        }
    }
}
