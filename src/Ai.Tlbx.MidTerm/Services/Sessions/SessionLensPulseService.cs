using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Services.Updates;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed partial class SessionLensPulseService
{
    private const int DefaultHistoryWindowSize = 80;
    private const string ScreenLogFormatVersion = "midterm-lens-screen-log-v1";
    private const int CollapsibleHistoryBodyMinLines = 8;
    private const int CollapsibleHistoryBodyMinChars = 320;
    private const int HistoryPreviewMaxChars = 160;
    private readonly ConcurrentDictionary<string, SessionLensPulseLog> _logs = new(StringComparer.Ordinal);
    private readonly string _storeDirectory;
    private readonly bool _screenLoggingEnabled;
    private readonly string? _screenLogDirectory;

    public SessionLensPulseService(
        SettingsService? settingsService = null,
        string? storeDirectory = null,
        bool? enableScreenLogging = null,
        string? screenLogDirectory = null)
    {
        _storeDirectory = storeDirectory ??
                          (settingsService is not null
                              ? Path.Combine(settingsService.SettingsDirectory, "lens-history")
                              : Path.Combine(Path.GetTempPath(), "midterm-lens-history", Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(_storeDirectory);

        _screenLoggingEnabled = enableScreenLogging ??
                                (settingsService is not null &&
                                 (UpdateService.IsDevEnvironment || settingsService.Load().DevMode));

        if (!_screenLoggingEnabled)
        {
            return;
        }

        _screenLogDirectory = screenLogDirectory ?? ResolveScreenLogDirectory(settingsService);
        Directory.CreateDirectory(_screenLogDirectory);
    }

    public void Append(LensPulseEvent lensEvent)
    {
        ArgumentNullException.ThrowIfNull(lensEvent);

        var log = GetOrLoadLog(lensEvent.SessionId);
        lock (log.SyncRoot)
        {
            lensEvent.Sequence = ++log.NextSequence;
            log.Events.Add(lensEvent);
            ApplyEvent(log.State, lensEvent);
            var delta = BuildDelta(log.SessionId, log.NextSequence, log.State, lensEvent);
            PersistEvent(log.SessionId, lensEvent);
            PersistScreenLogDelta(log, delta);

            var staleSubscribers = new List<LensPulseSubscriber>();
            foreach (var subscriber in log.Subscribers)
            {
                if (!subscriber.Writer.TryWrite(CloneEvent(lensEvent)))
                {
                    staleSubscribers.Add(subscriber);
                }
            }

            if (staleSubscribers.Count > 0)
            {
                foreach (var staleSubscriber in staleSubscribers)
                {
                    log.Subscribers.Remove(staleSubscriber);
                }
            }

            var staleDeltaSubscribers = new List<LensPulseDeltaSubscriber>();
            foreach (var subscriber in log.DeltaSubscribers)
            {
                if (!subscriber.Writer.TryWrite(CloneDelta(delta)))
                {
                    staleDeltaSubscribers.Add(subscriber);
                }
            }

            if (staleDeltaSubscribers.Count > 0)
            {
                foreach (var staleSubscriber in staleDeltaSubscribers)
                {
                    log.DeltaSubscribers.Remove(staleSubscriber);
                }
            }
        }
    }

    public LensPulseSubscription Subscribe(string sessionId, long afterSequence, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);

        var log = GetOrLoadLog(sessionId);
        var channel = Channel.CreateUnbounded<LensPulseEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });
        var subscriber = new LensPulseSubscriber(channel.Writer);
        List<LensPulseEvent> backlog;

        lock (log.SyncRoot)
        {
            backlog = log.Events
                .Where(lensEvent => lensEvent.Sequence > afterSequence)
                .Select(CloneEvent)
                .ToList();
            log.Subscribers.Add(subscriber);
        }

        foreach (var lensEvent in backlog)
        {
            channel.Writer.TryWrite(lensEvent);
        }

        CancellationTokenRegistration registration = default;

        var subscription = new LensPulseSubscription(
            channel.Reader,
            () =>
            {
                registration.Dispose();
                lock (log.SyncRoot)
                {
                    log.Subscribers.Remove(subscriber);
                }

                channel.Writer.TryComplete();
            });

        if (cancellationToken.CanBeCanceled)
        {
            registration = cancellationToken.Register(static state =>
            {
                if (state is LensPulseSubscription subscription)
                {
                    subscription.Dispose();
                }
            }, subscription);
        }

        return subscription;
    }

    public LensPulseEventListResponse GetEvents(string sessionId, long afterSequence = 0)
    {
        if (!TryGetLog(sessionId, out var log))
        {
            return new LensPulseEventListResponse
            {
                SessionId = sessionId
            };
        }

        lock (log.SyncRoot)
        {
            return new LensPulseEventListResponse
            {
                SessionId = sessionId,
                LatestSequence = log.NextSequence,
                Events = log.Events
                    .Where(e => e.Sequence > afterSequence)
                    .Select(CloneEvent)
                    .ToList()
            };
        }
    }

    public LensPulseDeltaSubscription SubscribeDeltas(string sessionId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);

        var log = GetOrLoadLog(sessionId);
        var channel = Channel.CreateUnbounded<LensPulseDeltaResponse>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });
        var subscriber = new LensPulseDeltaSubscriber(channel.Writer);

        lock (log.SyncRoot)
        {
            log.DeltaSubscribers.Add(subscriber);
        }

        CancellationTokenRegistration registration = default;

        var subscription = new LensPulseDeltaSubscription(
            channel.Reader,
            () =>
            {
                registration.Dispose();
                lock (log.SyncRoot)
                {
                    log.DeltaSubscribers.Remove(subscriber);
                }

                channel.Writer.TryComplete();
            });

        if (cancellationToken.CanBeCanceled)
        {
            registration = cancellationToken.Register(static state =>
            {
                if (state is LensPulseDeltaSubscription subscription)
                {
                    subscription.Dispose();
                }
            }, subscription);
        }

        return subscription;
    }

    public bool HasHistory(string sessionId)
    {
        if (!TryGetLog(sessionId, out var log))
        {
            return false;
        }

        lock (log.SyncRoot)
        {
            return log.Events.Count > 0;
        }
    }

    public LensPulseSnapshotResponse? GetSnapshot(string sessionId)
    {
        if (!TryGetLog(sessionId, out var log))
        {
            return null;
        }

        lock (log.SyncRoot)
        {
            if (log.Events.Count == 0)
            {
                return null;
            }
            return CloneSnapshot(sessionId, log.NextSequence, log.State, 0, null);
        }
    }

    public LensPulseSnapshotResponse? GetSnapshotWindow(string sessionId, int? startIndex = null, int? count = null)
    {
        if (!TryGetLog(sessionId, out var log))
        {
            return null;
        }

        lock (log.SyncRoot)
        {
            if (log.Events.Count == 0)
            {
                return null;
            }

            var totalCount = log.State.TranscriptEntries.Count;
            var boundedCount = Math.Max(1, count ?? DefaultHistoryWindowSize);
            var effectiveStart = startIndex ?? Math.Max(0, totalCount - boundedCount);
            effectiveStart = Math.Clamp(effectiveStart, 0, Math.Max(0, totalCount - 1));
            return CloneSnapshot(sessionId, log.NextSequence, log.State, effectiveStart, boundedCount);
        }
    }

    public void Forget(string sessionId)
    {
        if (_logs.TryRemove(sessionId, out var log))
        {
            lock (log.SyncRoot)
            {
                foreach (var subscriber in log.Subscribers)
                {
                    subscriber.Writer.TryComplete();
                }

                foreach (var subscriber in log.DeltaSubscribers)
                {
                    subscriber.Writer.TryComplete();
                }

                log.Subscribers.Clear();
                log.DeltaSubscribers.Clear();
            }

            TryDeleteStore(sessionId);
        }
    }

    private bool TryGetLog(string sessionId, out SessionLensPulseLog log)
    {
        if (_logs.TryGetValue(sessionId, out log!))
        {
            return true;
        }

        if (TryLoadLog(sessionId, out var loaded))
        {
            log = _logs.GetOrAdd(sessionId, loaded);
            return true;
        }

        log = null!;
        return false;
    }

    private SessionLensPulseLog GetOrLoadLog(string sessionId)
    {
        return _logs.GetOrAdd(sessionId, LoadLog);
    }

    private SessionLensPulseLog LoadLog(string sessionId)
    {
        if (TryLoadLog(sessionId, out var log))
        {
            return log;
        }

        return new SessionLensPulseLog(sessionId);
    }

    private bool TryLoadLog(string sessionId, out SessionLensPulseLog log)
    {
        log = new SessionLensPulseLog(sessionId);
        var path = GetStorePath(sessionId);
        if (!File.Exists(path))
        {
            return false;
        }

        foreach (var line in File.ReadLines(path, Encoding.UTF8))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var lensEvent = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensPulseEvent);
            if (lensEvent is null)
            {
                continue;
            }

            log.Events.Add(lensEvent);
            log.NextSequence = Math.Max(log.NextSequence, lensEvent.Sequence);
            ApplyEvent(log.State, lensEvent);
        }

        return log.Events.Count > 0;
    }

    private void PersistEvent(string sessionId, LensPulseEvent lensEvent)
    {
        var path = GetStorePath(sessionId);
        var payload = JsonSerializer.Serialize(lensEvent, LensHostJsonContext.Default.LensPulseEvent);
        File.AppendAllText(path, payload + Environment.NewLine, Encoding.UTF8);
    }

    private void TryDeleteStore(string sessionId)
    {
        var path = GetStorePath(sessionId);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    private static string ResolveScreenLogDirectory(SettingsService? settingsService)
    {
        if (settingsService is null)
        {
            return Path.Combine(Path.GetTempPath(), "midterm-lens-logs");
        }

        var isWindowsService = OperatingSystem.IsWindows() && settingsService.IsRunningAsService;
        var isUnixService = !OperatingSystem.IsWindows() && settingsService.IsRunningAsService;
        var logRoot = LogPaths.GetLogDirectory(isWindowsService, isUnixService);
        return Path.Combine(logRoot, "lens");
    }

    private string GetStorePath(string sessionId)
    {
        var safeName = Uri.EscapeDataString(sessionId);
        return Path.Combine(_storeDirectory, $"{safeName}.ndjson");
    }

    private void PersistScreenLogDelta(SessionLensPulseLog log, LensPulseDeltaResponse delta)
    {
        if (!_screenLoggingEnabled || string.IsNullOrWhiteSpace(_screenLogDirectory))
        {
            return;
        }

        var screenLogPath = EnsureScreenLogPath(log, delta.Provider, delta.GeneratedAt);
        if (screenLogPath is null)
        {
            return;
        }

        var record = new LensScreenLogDeltaRecord
        {
            Format = ScreenLogFormatVersion,
            RecordType = "screen_delta",
            LogId = log.ScreenLogId ?? string.Empty,
            SessionId = log.SessionId,
            Provider = delta.Provider,
            LatestSequence = delta.LatestSequence,
            RecordedAt = delta.GeneratedAt,
            Session = new LensScreenLogSessionState
            {
                State = delta.Session.State,
                StateLabel = delta.Session.StateLabel,
                Reason = delta.Session.Reason,
                LastError = delta.Session.LastError
            },
            CurrentTurn = new LensScreenLogTurnState
            {
                TurnId = delta.CurrentTurn.TurnId,
                State = delta.CurrentTurn.State,
                StateLabel = delta.CurrentTurn.StateLabel,
                Model = delta.CurrentTurn.Model,
                Effort = delta.CurrentTurn.Effort
            },
            HistoryUpserts = delta.HistoryUpserts
                .Select(BuildScreenLogHistoryEntry)
                .OrderBy(entry => entry.Order)
                .ToList(),
            HistoryRemovals = [.. delta.HistoryRemovals]
        };

        File.AppendAllText(
            screenLogPath,
            JsonSerializer.Serialize(record, LensScreenLogJsonContext.Default.LensScreenLogDeltaRecord) + Environment.NewLine,
            Encoding.UTF8);
    }

    private string? EnsureScreenLogPath(SessionLensPulseLog log, string provider, DateTimeOffset createdAt)
    {
        if (string.IsNullOrWhiteSpace(_screenLogDirectory))
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(log.ScreenLogPath))
        {
            return log.ScreenLogPath;
        }

        log.ScreenLogId = Guid.CreateVersion7().ToString("N");
        log.ScreenLogPath = Path.Combine(_screenLogDirectory, $"{log.ScreenLogId}.lenslog.jsonl");

        var header = new LensScreenLogHeaderRecord
        {
            Format = ScreenLogFormatVersion,
            RecordType = "header",
            LogId = log.ScreenLogId,
            SessionId = log.SessionId,
            Provider = provider,
            CreatedAt = createdAt
        };

        File.AppendAllText(
            log.ScreenLogPath,
            JsonSerializer.Serialize(header, LensScreenLogJsonContext.Default.LensScreenLogHeaderRecord) + Environment.NewLine,
            Encoding.UTF8);

        return log.ScreenLogPath;
    }

    private static void ApplyEvent(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.Provider))
        {
            state.Provider = lensEvent.Provider;
        }

        if (!string.IsNullOrWhiteSpace(lensEvent.ThreadId))
        {
            state.Thread.ThreadId = lensEvent.ThreadId;
        }

        state.Session.LastEventAt = lensEvent.CreatedAt;
        ApplySessionState(state, lensEvent);
        ApplyThreadState(state, lensEvent);

        if (lensEvent.TurnStarted is not null)
        {
            ApplyTurnStarted(state, lensEvent);
        }

        if (lensEvent.TurnCompleted is not null)
        {
            ApplyTurnCompleted(state, lensEvent);
        }

        if (lensEvent.ContentDelta is not null)
        {
            ApplyContentDelta(state, lensEvent);
        }

        if (lensEvent.PlanDelta is not null || lensEvent.PlanCompleted is not null)
        {
            ApplyPlanUpdate(state, lensEvent);
        }

        if (lensEvent.DiffUpdated is not null)
        {
            ApplyDiffUpdate(state, lensEvent);
        }

        if (lensEvent.Item is not null)
        {
            ApplyItemUpdate(state, lensEvent);
        }

        if (lensEvent.RequestOpened is not null ||
            lensEvent.RequestResolved is not null ||
            lensEvent.UserInputRequested is not null ||
            lensEvent.UserInputResolved is not null)
        {
            ApplyRequestUpdate(state, lensEvent);
        }

        if (lensEvent.RuntimeMessage is not null)
        {
            ApplyRuntimeNotice(state, lensEvent);
        }
    }

    private static LensPulseSnapshotResponse CloneSnapshot(
        string sessionId,
        long latestSequence,
        LensConversationState state,
        int historyWindowStart,
        int? historyWindowCount)
    {
        var orderedHistory = state.TranscriptEntries.Values
            .OrderBy(entry => entry.Order)
            .ToList();
        var totalHistoryCount = orderedHistory.Count;
        var boundedStart = Math.Clamp(historyWindowStart, 0, totalHistoryCount == 0 ? 0 : totalHistoryCount - 1);
        var boundedCount = historyWindowCount is null
            ? totalHistoryCount
            : Math.Max(1, historyWindowCount.Value);
        if (totalHistoryCount == 0)
        {
            boundedStart = 0;
            boundedCount = 0;
        }

        var historySlice = orderedHistory
            .Skip(boundedStart)
            .Take(boundedCount)
            .Select(CloneTranscriptEntry)
            .ToList();
        var historyWindowEnd = boundedStart + historySlice.Count;

        return new LensPulseSnapshotResponse
        {
            SessionId = sessionId,
            Provider = state.Provider,
            GeneratedAt = state.Session.LastEventAt ?? DateTimeOffset.UtcNow,
            LatestSequence = latestSequence,
            TotalHistoryCount = totalHistoryCount,
            HistoryWindowStart = boundedStart,
            HistoryWindowEnd = historyWindowEnd,
            HasOlderHistory = boundedStart > 0,
            HasNewerHistory = historyWindowEnd < totalHistoryCount,
            Session = CloneSessionSummary(state.Session),
            Thread = CloneThreadSummary(state.Thread),
            CurrentTurn = CloneTurnSummary(state.CurrentTurn),
            Streams = CloneStreamsSummary(state.Streams),
            Transcript = historySlice,
            Items = state.Items.Values
                .OrderByDescending(item => item.UpdatedAt)
                .Select(CloneItemSummary)
                .ToList(),
            Requests = state.Requests.Values
                .OrderByDescending(request => request.UpdatedAt)
                .Select(CloneRequestSummary)
                .ToList(),
            Notices = state.Notices
                .OrderByDescending(notice => notice.CreatedAt)
                .Select(CloneRuntimeNotice)
                .ToList()
        };
    }

    private static LensPulseDeltaResponse BuildDelta(
        string sessionId,
        long latestSequence,
        LensConversationState state,
        LensPulseEvent lensEvent)
    {
        var historyIds = CollectTouchedHistoryIds(state, lensEvent);
        var itemIds = CollectTouchedItemIds(state, lensEvent);
        var requestIds = CollectTouchedRequestIds(lensEvent);
        var noticeIds = CollectTouchedNoticeIds(lensEvent);

        return new LensPulseDeltaResponse
        {
            SessionId = sessionId,
            Provider = state.Provider,
            GeneratedAt = state.Session.LastEventAt ?? lensEvent.CreatedAt,
            LatestSequence = latestSequence,
            TotalHistoryCount = state.TranscriptEntries.Count,
            Session = CloneSessionSummary(state.Session),
            Thread = CloneThreadSummary(state.Thread),
            CurrentTurn = CloneTurnSummary(state.CurrentTurn),
            Streams = CloneStreamsSummary(state.Streams),
            HistoryUpserts = historyIds
                .Select(id => state.TranscriptEntries.TryGetValue(id, out var entry) ? CloneTranscriptEntry(entry) : null)
                .Where(static entry => entry is not null)
                .Select(static entry => entry!)
                .OrderBy(entry => entry.Order)
                .ToList(),
            ItemUpserts = itemIds
                .Select(id => state.Items.TryGetValue(id, out var item) ? CloneItemSummary(item) : null)
                .Where(static item => item is not null)
                .Select(static item => item!)
                .OrderByDescending(item => item.UpdatedAt)
                .ToList(),
            RequestUpserts = requestIds
                .Select(id => state.Requests.TryGetValue(id, out var request) ? CloneRequestSummary(request) : null)
                .Where(static request => request is not null)
                .Select(static request => request!)
                .OrderByDescending(request => request.UpdatedAt)
                .ToList(),
            NoticeUpserts = noticeIds
                .Select(id => state.Notices.LastOrDefault(notice => string.Equals(notice.EventId, id, StringComparison.Ordinal)))
                .Where(static notice => notice is not null)
                .Select(static notice => CloneRuntimeNotice(notice!))
                .OrderByDescending(notice => notice.CreatedAt)
                .ToList()
        };
    }

    private static void ApplyTurnStarted(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.TurnId) &&
            !string.Equals(state.CurrentTurn.TurnId, lensEvent.TurnId, StringComparison.Ordinal))
        {
            ResetStreams(state.Streams);
        }

        state.CurrentTurn.TurnId = lensEvent.TurnId;
        state.CurrentTurn.State = "running";
        state.CurrentTurn.StateLabel = "Running";
        state.CurrentTurn.Model = lensEvent.TurnStarted?.Model;
        state.CurrentTurn.Effort = lensEvent.TurnStarted?.Effort;
        state.CurrentTurn.StartedAt = lensEvent.CreatedAt;
        state.CurrentTurn.CompletedAt = null;
    }

    private static void ApplyTurnCompleted(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.TurnId))
        {
            state.CurrentTurn.TurnId = lensEvent.TurnId;
        }

        state.CurrentTurn.State = lensEvent.TurnCompleted?.State ?? state.CurrentTurn.State;
        state.CurrentTurn.StateLabel = lensEvent.TurnCompleted?.StateLabel ?? state.CurrentTurn.StateLabel;
        state.CurrentTurn.CompletedAt = lensEvent.CreatedAt;
        if (!string.IsNullOrWhiteSpace(lensEvent.TurnCompleted?.ErrorMessage))
        {
            state.Session.LastError = lensEvent.TurnCompleted.ErrorMessage;
        }

        CompleteStreamingTranscriptEntries(state, lensEvent.TurnId);
    }

    private static void ApplyPlanUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.PlanDelta?.Delta))
        {
            state.Streams.PlanText = AppendTranscriptChunk(state.Streams.PlanText, lensEvent.PlanDelta.Delta);
        }

        if (!string.IsNullOrWhiteSpace(lensEvent.PlanCompleted?.PlanMarkdown))
        {
            state.Streams.PlanText = NormalizeTranscriptText(lensEvent.PlanCompleted.PlanMarkdown);
        }

        var entry = EnsureTranscriptEntry(
            state,
            $"plan:{lensEvent.TurnId ?? state.CurrentTurn.TurnId ?? lensEvent.EventId}",
            "plan",
            lensEvent.CreatedAt);
        entry.TurnId = lensEvent.TurnId ?? state.CurrentTurn.TurnId;
        entry.Status = "completed";
        entry.Title = "Plan";
        entry.Body = !string.IsNullOrWhiteSpace(lensEvent.PlanCompleted?.PlanMarkdown)
            ? NormalizeTranscriptText(lensEvent.PlanCompleted.PlanMarkdown)
            : AppendTranscriptChunk(entry.Body, lensEvent.PlanDelta?.Delta);
        entry.Streaming = false;
        entry.UpdatedAt = lensEvent.CreatedAt;
    }

    private static void ApplyDiffUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        state.Streams.UnifiedDiff = NormalizeTranscriptText(lensEvent.DiffUpdated?.UnifiedDiff);
        var entry = EnsureTranscriptEntry(
            state,
            $"diff:{lensEvent.TurnId ?? state.CurrentTurn.TurnId ?? lensEvent.EventId}",
            "diff",
            lensEvent.CreatedAt);
        entry.TurnId = lensEvent.TurnId ?? state.CurrentTurn.TurnId;
        entry.Status = "updated";
        entry.Title = "Working diff";
        entry.Body = state.Streams.UnifiedDiff;
        entry.Streaming = false;
        entry.UpdatedAt = lensEvent.CreatedAt;
    }

    private static void ApplySessionState(LensPulseSnapshotResponse snapshot, LensPulseEvent lensEvent)
    {
        if (lensEvent.SessionState is null)
        {
            return;
        }

        snapshot.Session.State = lensEvent.SessionState.State;
        snapshot.Session.StateLabel = lensEvent.SessionState.StateLabel;
        snapshot.Session.Reason = lensEvent.SessionState.Reason;
        if (string.Equals(lensEvent.SessionState.State, "error", StringComparison.OrdinalIgnoreCase))
        {
            snapshot.Session.LastError = lensEvent.SessionState.Reason;
        }
    }

    private static void ApplyThreadState(LensPulseSnapshotResponse snapshot, LensPulseEvent lensEvent)
    {
        if (lensEvent.ThreadState is null)
        {
            return;
        }

        snapshot.Thread.State = lensEvent.ThreadState.State;
        snapshot.Thread.StateLabel = lensEvent.ThreadState.StateLabel;
        if (!string.IsNullOrWhiteSpace(lensEvent.ThreadState.ProviderThreadId))
        {
            snapshot.Thread.ThreadId = lensEvent.ThreadState.ProviderThreadId;
        }
    }

    private static void ApplySessionState(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (lensEvent.SessionState is null)
        {
            return;
        }

        state.Session.State = lensEvent.SessionState.State;
        state.Session.StateLabel = lensEvent.SessionState.StateLabel;
        state.Session.Reason = lensEvent.SessionState.Reason;
        if (string.Equals(lensEvent.SessionState.State, "error", StringComparison.OrdinalIgnoreCase))
        {
            state.Session.LastError = lensEvent.SessionState.Reason;
        }
    }

    private static void ApplyThreadState(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (lensEvent.ThreadState is null)
        {
            return;
        }

        state.Thread.State = lensEvent.ThreadState.State;
        state.Thread.StateLabel = lensEvent.ThreadState.StateLabel;
        if (!string.IsNullOrWhiteSpace(lensEvent.ThreadState.ProviderThreadId))
        {
            state.Thread.ThreadId = lensEvent.ThreadState.ProviderThreadId;
        }
    }

    private static void ApplyContentDelta(
        LensPulseEvent lensEvent,
        StringBuilder assistant,
        StringBuilder reasoning,
        StringBuilder reasoningSummary,
        StringBuilder plan,
        StringBuilder commandOutput,
        StringBuilder fileChangeOutput)
    {
        if (lensEvent.ContentDelta is null)
        {
            return;
        }

        switch (lensEvent.ContentDelta.StreamKind)
        {
            case "assistant_text":
                assistant.Append(lensEvent.ContentDelta.Delta);
                break;
            case "reasoning_text":
                reasoning.Append(lensEvent.ContentDelta.Delta);
                break;
            case "reasoning_summary_text":
                reasoningSummary.Append(lensEvent.ContentDelta.Delta);
                break;
            case "plan_text":
                plan.Append(lensEvent.ContentDelta.Delta);
                break;
            case "command_output":
                commandOutput.Append(lensEvent.ContentDelta.Delta);
                break;
            case "file_change_output":
                fileChangeOutput.Append(lensEvent.ContentDelta.Delta);
                break;
        }
    }

    private static void ApplyContentDelta(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (lensEvent.ContentDelta is null)
        {
            return;
        }

        switch (lensEvent.ContentDelta.StreamKind)
        {
            case "assistant_text":
                state.Streams.AssistantText = AppendAssistantDelta(state.Streams.AssistantText, lensEvent.ContentDelta.Delta);
                break;
            case "reasoning_text":
                state.Streams.ReasoningText = AppendTranscriptChunk(state.Streams.ReasoningText, lensEvent.ContentDelta.Delta);
                break;
            case "reasoning_summary_text":
                state.Streams.ReasoningSummaryText = AppendTranscriptChunk(state.Streams.ReasoningSummaryText, lensEvent.ContentDelta.Delta);
                break;
            case "plan_text":
                state.Streams.PlanText = AppendTranscriptChunk(state.Streams.PlanText, lensEvent.ContentDelta.Delta);
                break;
            case "command_output":
                state.Streams.CommandOutput = AppendTranscriptChunk(state.Streams.CommandOutput, lensEvent.ContentDelta.Delta);
                break;
            case "file_change_output":
                state.Streams.FileChangeOutput = AppendTranscriptChunk(state.Streams.FileChangeOutput, lensEvent.ContentDelta.Delta);
                break;
        }

        var transcriptKind = TranscriptKindFromStream(lensEvent.ContentDelta.StreamKind);
        if (transcriptKind is null)
        {
            return;
        }

        var entry = EnsureTranscriptEntry(
            state,
            ResolveTranscriptEntryIdForStream(state, lensEvent, transcriptKind, lensEvent.ContentDelta.StreamKind),
            transcriptKind,
            lensEvent.CreatedAt);
        entry.TurnId = lensEvent.TurnId ?? state.CurrentTurn.TurnId;
        entry.ItemId = lensEvent.ItemId;
        entry.ItemType = lensEvent.ContentDelta.StreamKind;
        entry.Status = "streaming";
        entry.Title = ResolveStreamTitle(transcriptKind, lensEvent.ContentDelta.StreamKind, entry.Title);
        entry.Body = transcriptKind == "assistant"
            ? AppendAssistantDelta(entry.Body, lensEvent.ContentDelta.Delta)
            : AppendTranscriptChunk(entry.Body, lensEvent.ContentDelta.Delta);
        entry.Streaming = true;
        entry.UpdatedAt = lensEvent.CreatedAt;
    }

    private static LensPulseRequestSummary GetOrCreateRequestSummary(
        IDictionary<string, LensPulseRequestSummary> requests,
        string requestId,
        string? turnId)
    {
        if (!requests.TryGetValue(requestId, out var request))
        {
            request = new LensPulseRequestSummary
            {
                RequestId = requestId,
                TurnId = turnId,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            requests[requestId] = request;
        }

        return request;
    }

    private static LensPulseItemSummary GetOrCreateItemSummary(
        IDictionary<string, LensPulseItemSummary> items,
        string itemId,
        string? turnId)
    {
        if (!items.TryGetValue(itemId, out var item))
        {
            item = new LensPulseItemSummary
            {
                ItemId = itemId,
                TurnId = turnId,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            items[itemId] = item;
        }

        return item;
    }

    private static string HumanizeRequestType(string requestType)
    {
        return requestType switch
        {
            "command_execution_approval" => "Command approval",
            "file_read_approval" => "File read approval",
            "file_change_approval" => "File change approval",
            "tool_user_input" => "User input",
            _ => requestType
        };
    }

    private static void ApplyItemUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (lensEvent.Item is null)
        {
            return;
        }

        var normalizedType = NormalizeItemType(lensEvent.Item.ItemType);
        var transcriptKind = TranscriptKindFromItem(normalizedType);
        var canonicalItemId = ResolveCanonicalItemId(state.Items, lensEvent, transcriptKind);
        var item = GetOrCreateItemSummary(state.Items, canonicalItemId, lensEvent.TurnId);
        item.TurnId = lensEvent.TurnId ?? item.TurnId;
        item.ItemType = normalizedType;
        item.Status = transcriptKind == "user"
            ? ChoosePreferredUserMessageStatus(item.Status, lensEvent.Item.Status)
            : PreferNonEmpty(lensEvent.Item.Status, item.Status);
        item.Title = transcriptKind == "tool"
            ? PreferNonGenericText(item.Title, lensEvent.Item.Title)
            : PreferMeaningfulText(item.Title, lensEvent.Item.Title);
        item.Detail = transcriptKind switch
        {
            "assistant" => MergeProgressiveMessage(item.Detail, lensEvent.Item.Detail),
            "tool" => MergeTranscriptBody(item.Detail, lensEvent.Item.Detail),
            "user" => PreferMeaningfulText(item.Detail, lensEvent.Item.Detail),
            _ => MergeTranscriptBody(item.Detail, lensEvent.Item.Detail)
        };
        item.Attachments = MergeAttachments(item.Attachments, lensEvent.Item.Attachments);
        item.UpdatedAt = lensEvent.CreatedAt;

        var entry = EnsureTranscriptEntry(
            state,
            ResolveTranscriptEntryIdForItem(lensEvent, transcriptKind, canonicalItemId),
            transcriptKind,
            lensEvent.CreatedAt);
        entry.TurnId = lensEvent.TurnId ?? entry.TurnId;
        entry.ItemId = canonicalItemId;
        entry.Status = item.Status;
        entry.ItemType = normalizedType;
        entry.Attachments = MergeAttachments(entry.Attachments, lensEvent.Item.Attachments);
        entry.UpdatedAt = lensEvent.CreatedAt;

        switch (transcriptKind)
        {
            case "user":
                entry.Title = null;
                entry.Body = PreferMeaningfulText(entry.Body, lensEvent.Item.Detail) ?? string.Empty;
                entry.Streaming = false;
                break;
            case "assistant":
                entry.Title = null;
                entry.Body = MergeProgressiveMessage(entry.Body, lensEvent.Item.Detail);
                entry.Streaming = !IsTerminalStatus(item.Status);
                break;
            default:
                entry.Title = PreferNonGenericText(entry.Title, lensEvent.Item.Title);
                entry.Body = MergeTranscriptBody(entry.Body, lensEvent.Item.Detail);
                entry.Streaming = !IsTerminalStatus(item.Status);
                break;
        }
    }

    private static void ApplyRequestUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        var requestId = string.IsNullOrWhiteSpace(lensEvent.RequestId)
            ? $"request:{lensEvent.EventId}"
            : lensEvent.RequestId;
        var request = GetOrCreateRequestSummary(state.Requests, requestId, lensEvent.TurnId);
        request.TurnId = lensEvent.TurnId ?? request.TurnId;
        request.UpdatedAt = lensEvent.CreatedAt;

        if (lensEvent.RequestOpened is not null)
        {
            request.Kind = lensEvent.RequestOpened.RequestType;
            request.KindLabel = PreferNonEmpty(
                lensEvent.RequestOpened.RequestTypeLabel,
                HumanizeRequestType(lensEvent.RequestOpened.RequestType));
            request.State = "open";
            request.Detail = PreferMeaningfulText(request.Detail, lensEvent.RequestOpened.Detail);
        }

        if (lensEvent.RequestResolved is not null)
        {
            request.Kind = PreferNonEmpty(lensEvent.RequestResolved.RequestType, request.Kind);
            request.KindLabel = PreferNonEmpty(request.KindLabel, HumanizeRequestType(request.Kind));
            request.State = "resolved";
            request.Decision = lensEvent.RequestResolved.Decision;
        }

        if (lensEvent.UserInputRequested is not null)
        {
            request.Kind = "tool_user_input";
            request.KindLabel = HumanizeRequestType(request.Kind);
            request.State = "open";
            request.Questions = lensEvent.UserInputRequested.Questions.Select(CloneQuestion).ToList();
        }

        if (lensEvent.UserInputResolved is not null)
        {
            request.Kind = PreferNonEmpty(request.Kind, "tool_user_input");
            request.KindLabel = PreferNonEmpty(request.KindLabel, HumanizeRequestType(request.Kind));
            request.State = "resolved";
            request.Answers = lensEvent.UserInputResolved.Answers.Select(CloneAnsweredQuestion).ToList();
        }

        var entry = EnsureTranscriptEntry(state, $"request:{requestId}", "request", lensEvent.CreatedAt);
        entry.TurnId = request.TurnId;
        entry.RequestId = request.RequestId;
        entry.Status = request.State;
        entry.Title = request.KindLabel;
        entry.Body = BuildRequestBody(request);
        entry.Streaming = false;
        entry.UpdatedAt = lensEvent.CreatedAt;
    }

    private static void ApplyRuntimeNotice(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (lensEvent.RuntimeMessage is null)
        {
            return;
        }

        state.Notices.Add(new LensPulseRuntimeNotice
        {
            EventId = lensEvent.EventId,
            Type = lensEvent.Type,
            Message = lensEvent.RuntimeMessage.Message,
            Detail = lensEvent.RuntimeMessage.Detail,
            CreatedAt = lensEvent.CreatedAt
        });
        if (state.Notices.Count > 64)
        {
            state.Notices.RemoveRange(0, state.Notices.Count - 64);
        }

        if (lensEvent.Type is not "runtime.error" and not "runtime.warning")
        {
            return;
        }

        var entry = EnsureTranscriptEntry(
            state,
            $"runtime:{lensEvent.EventId}",
            lensEvent.Type == "runtime.error" ? "notice" : "system",
            lensEvent.CreatedAt);
        entry.Status = lensEvent.Type;
        entry.Title = lensEvent.Type == "runtime.error" ? "Error" : "Runtime";
        entry.Body = string.Join(
            "\n\n",
            new[] { lensEvent.RuntimeMessage.Message, lensEvent.RuntimeMessage.Detail }
                .Where(static value => !string.IsNullOrWhiteSpace(value)));
        entry.Streaming = false;
        entry.UpdatedAt = lensEvent.CreatedAt;
    }

    private static LensPulseEvent CloneEvent(LensPulseEvent source)
    {
        return new LensPulseEvent
        {
            Sequence = source.Sequence,
            EventId = source.EventId,
            SessionId = source.SessionId,
            Provider = source.Provider,
            ThreadId = source.ThreadId,
            TurnId = source.TurnId,
            ItemId = source.ItemId,
            RequestId = source.RequestId,
            CreatedAt = source.CreatedAt,
            Type = source.Type,
            Raw = source.Raw is null ? null : new LensPulseEventRaw
            {
                Source = source.Raw.Source,
                Method = source.Raw.Method,
                PayloadJson = source.Raw.PayloadJson
            },
            SessionState = source.SessionState is null ? null : new LensPulseSessionStatePayload
            {
                State = source.SessionState.State,
                StateLabel = source.SessionState.StateLabel,
                Reason = source.SessionState.Reason
            },
            ThreadState = source.ThreadState is null ? null : new LensPulseThreadStatePayload
            {
                State = source.ThreadState.State,
                StateLabel = source.ThreadState.StateLabel,
                ProviderThreadId = source.ThreadState.ProviderThreadId
            },
            TurnStarted = source.TurnStarted is null ? null : new LensPulseTurnStartedPayload
            {
                Model = source.TurnStarted.Model,
                Effort = source.TurnStarted.Effort
            },
            TurnCompleted = source.TurnCompleted is null ? null : new LensPulseTurnCompletedPayload
            {
                State = source.TurnCompleted.State,
                StateLabel = source.TurnCompleted.StateLabel,
                StopReason = source.TurnCompleted.StopReason,
                ErrorMessage = source.TurnCompleted.ErrorMessage
            },
            ContentDelta = source.ContentDelta is null ? null : new LensPulseContentDeltaPayload
            {
                StreamKind = source.ContentDelta.StreamKind,
                Delta = source.ContentDelta.Delta
            },
            PlanDelta = source.PlanDelta is null ? null : new LensPulsePlanDeltaPayload
            {
                Delta = source.PlanDelta.Delta
            },
            PlanCompleted = source.PlanCompleted is null ? null : new LensPulsePlanCompletedPayload
            {
                PlanMarkdown = source.PlanCompleted.PlanMarkdown
            },
            DiffUpdated = source.DiffUpdated is null ? null : new LensPulseDiffUpdatedPayload
            {
                UnifiedDiff = source.DiffUpdated.UnifiedDiff
            },
            Item = source.Item is null ? null : new LensPulseItemPayload
            {
                ItemType = source.Item.ItemType,
                Status = source.Item.Status,
                Title = source.Item.Title,
                Detail = source.Item.Detail,
                Attachments = CloneAttachments(source.Item.Attachments)
            },
            RequestOpened = source.RequestOpened is null ? null : new LensPulseRequestOpenedPayload
            {
                RequestType = source.RequestOpened.RequestType,
                RequestTypeLabel = source.RequestOpened.RequestTypeLabel,
                Detail = source.RequestOpened.Detail
            },
            RequestResolved = source.RequestResolved is null ? null : new LensPulseRequestResolvedPayload
            {
                RequestType = source.RequestResolved.RequestType,
                Decision = source.RequestResolved.Decision
            },
            UserInputRequested = source.UserInputRequested is null ? null : new LensPulseUserInputRequestedPayload
            {
                Questions = source.UserInputRequested.Questions.Select(CloneQuestion).ToList()
            },
            UserInputResolved = source.UserInputResolved is null ? null : new LensPulseUserInputResolvedPayload
            {
                Answers = source.UserInputResolved.Answers.Select(CloneAnsweredQuestion).ToList()
            },
            RuntimeMessage = source.RuntimeMessage is null ? null : new LensPulseRuntimeMessagePayload
            {
                Message = source.RuntimeMessage.Message,
                Detail = source.RuntimeMessage.Detail
            }
        };
    }

    private static LensPulseDeltaResponse CloneDelta(LensPulseDeltaResponse source)
    {
        return new LensPulseDeltaResponse
        {
            SessionId = source.SessionId,
            Provider = source.Provider,
            GeneratedAt = source.GeneratedAt,
            LatestSequence = source.LatestSequence,
            TotalHistoryCount = source.TotalHistoryCount,
            Session = CloneSessionSummary(source.Session),
            Thread = CloneThreadSummary(source.Thread),
            CurrentTurn = CloneTurnSummary(source.CurrentTurn),
            Streams = CloneStreamsSummary(source.Streams),
            HistoryUpserts = source.HistoryUpserts.Select(CloneTranscriptEntry).ToList(),
            HistoryRemovals = [.. source.HistoryRemovals],
            ItemUpserts = source.ItemUpserts.Select(CloneItemSummary).ToList(),
            ItemRemovals = [.. source.ItemRemovals],
            RequestUpserts = source.RequestUpserts.Select(CloneRequestSummary).ToList(),
            RequestRemovals = [.. source.RequestRemovals],
            NoticeUpserts = source.NoticeUpserts.Select(CloneRuntimeNotice).ToList()
        };
    }

    private static LensPulseQuestion CloneQuestion(LensPulseQuestion source)
    {
        return new LensPulseQuestion
        {
            Id = source.Id,
            Header = source.Header,
            Question = source.Question,
            MultiSelect = source.MultiSelect,
            Options = source.Options.Select(option => new LensPulseQuestionOption
            {
                Label = option.Label,
                Description = option.Description
            }).ToList()
        };
    }

    private static LensPulseAnsweredQuestion CloneAnsweredQuestion(LensPulseAnsweredQuestion source)
    {
        return new LensPulseAnsweredQuestion
        {
            QuestionId = source.QuestionId,
            Answers = [.. source.Answers]
        };
    }

    private static LensPulseSessionSummary CloneSessionSummary(LensPulseSessionSummary source)
    {
        return new LensPulseSessionSummary
        {
            State = source.State,
            StateLabel = source.StateLabel,
            Reason = source.Reason,
            LastError = source.LastError,
            LastEventAt = source.LastEventAt
        };
    }

    private static LensPulseThreadSummary CloneThreadSummary(LensPulseThreadSummary source)
    {
        return new LensPulseThreadSummary
        {
            ThreadId = source.ThreadId,
            State = source.State,
            StateLabel = source.StateLabel
        };
    }

    private static LensPulseTurnSummary CloneTurnSummary(LensPulseTurnSummary source)
    {
        return new LensPulseTurnSummary
        {
            TurnId = source.TurnId,
            State = source.State,
            StateLabel = source.StateLabel,
            Model = source.Model,
            Effort = source.Effort,
            StartedAt = source.StartedAt,
            CompletedAt = source.CompletedAt
        };
    }

    private static LensPulseStreamsSummary CloneStreamsSummary(LensPulseStreamsSummary source)
    {
        return new LensPulseStreamsSummary
        {
            AssistantText = source.AssistantText,
            ReasoningText = source.ReasoningText,
            ReasoningSummaryText = source.ReasoningSummaryText,
            PlanText = source.PlanText,
            CommandOutput = source.CommandOutput,
            FileChangeOutput = source.FileChangeOutput,
            UnifiedDiff = source.UnifiedDiff
        };
    }

    private static LensPulseTranscriptEntry CloneTranscriptEntry(LensPulseTranscriptEntry source)
    {
        return new LensPulseTranscriptEntry
        {
            EntryId = source.EntryId,
            Order = source.Order,
            Kind = source.Kind,
            TurnId = source.TurnId,
            ItemId = source.ItemId,
            RequestId = source.RequestId,
            Status = source.Status,
            ItemType = source.ItemType,
            Title = source.Title,
            Body = source.Body,
            Attachments = CloneAttachments(source.Attachments),
            Streaming = source.Streaming,
            CreatedAt = source.CreatedAt,
            UpdatedAt = source.UpdatedAt
        };
    }

    private static LensPulseItemSummary CloneItemSummary(LensPulseItemSummary source)
    {
        return new LensPulseItemSummary
        {
            ItemId = source.ItemId,
            TurnId = source.TurnId,
            ItemType = source.ItemType,
            Status = source.Status,
            Title = source.Title,
            Detail = source.Detail,
            Attachments = CloneAttachments(source.Attachments),
            UpdatedAt = source.UpdatedAt
        };
    }

    private static LensPulseRequestSummary CloneRequestSummary(LensPulseRequestSummary source)
    {
        return new LensPulseRequestSummary
        {
            RequestId = source.RequestId,
            TurnId = source.TurnId,
            Kind = source.Kind,
            KindLabel = source.KindLabel,
            State = source.State,
            Detail = source.Detail,
            Decision = source.Decision,
            Questions = source.Questions.Select(CloneQuestion).ToList(),
            Answers = source.Answers.Select(CloneAnsweredQuestion).ToList(),
            UpdatedAt = source.UpdatedAt
        };
    }

    private static LensPulseRuntimeNotice CloneRuntimeNotice(LensPulseRuntimeNotice source)
    {
        return new LensPulseRuntimeNotice
        {
            EventId = source.EventId,
            Type = source.Type,
            Message = source.Message,
            Detail = source.Detail,
            CreatedAt = source.CreatedAt
        };
    }

    private static HashSet<string> CollectTouchedHistoryIds(
        LensConversationState state,
        LensPulseEvent lensEvent)
    {
        var historyIds = new HashSet<string>(StringComparer.Ordinal);

        if (lensEvent.ContentDelta is not null)
        {
            var transcriptKind = TranscriptKindFromStream(lensEvent.ContentDelta.StreamKind);
            if (transcriptKind is not null)
            {
                historyIds.Add(ResolveTranscriptEntryIdForStream(state, lensEvent, transcriptKind, lensEvent.ContentDelta.StreamKind));
            }
        }

        if (lensEvent.PlanDelta is not null || lensEvent.PlanCompleted is not null)
        {
            historyIds.Add($"plan:{lensEvent.TurnId ?? state.CurrentTurn.TurnId ?? lensEvent.EventId}");
        }

        if (lensEvent.DiffUpdated is not null)
        {
            historyIds.Add($"diff:{lensEvent.TurnId ?? state.CurrentTurn.TurnId ?? lensEvent.EventId}");
        }

        if (lensEvent.Item is not null)
        {
            var normalizedType = NormalizeItemType(lensEvent.Item.ItemType);
            var transcriptKind = TranscriptKindFromItem(normalizedType);
            var canonicalItemId = ResolveCanonicalItemId(state.Items, lensEvent, transcriptKind);
            historyIds.Add(ResolveTranscriptEntryIdForItem(lensEvent, transcriptKind, canonicalItemId));
        }

        if (lensEvent.RequestOpened is not null ||
            lensEvent.RequestResolved is not null ||
            lensEvent.UserInputRequested is not null ||
            lensEvent.UserInputResolved is not null)
        {
            historyIds.Add($"request:{ResolveRequestId(lensEvent)}");
        }

        if (lensEvent.RuntimeMessage is not null &&
            lensEvent.Type is "runtime.error" or "runtime.warning")
        {
            historyIds.Add($"runtime:{lensEvent.EventId}");
        }

        return historyIds;
    }

    private static HashSet<string> CollectTouchedItemIds(
        LensConversationState state,
        LensPulseEvent lensEvent)
    {
        var itemIds = new HashSet<string>(StringComparer.Ordinal);
        if (lensEvent.Item is null)
        {
            return itemIds;
        }

        var normalizedType = NormalizeItemType(lensEvent.Item.ItemType);
        var transcriptKind = TranscriptKindFromItem(normalizedType);
        itemIds.Add(ResolveCanonicalItemId(state.Items, lensEvent, transcriptKind));
        return itemIds;
    }

    private static HashSet<string> CollectTouchedRequestIds(LensPulseEvent lensEvent)
    {
        var requestIds = new HashSet<string>(StringComparer.Ordinal);
        if (lensEvent.RequestOpened is null &&
            lensEvent.RequestResolved is null &&
            lensEvent.UserInputRequested is null &&
            lensEvent.UserInputResolved is null)
        {
            return requestIds;
        }

        requestIds.Add(ResolveRequestId(lensEvent));
        return requestIds;
    }

    private static HashSet<string> CollectTouchedNoticeIds(LensPulseEvent lensEvent)
    {
        var noticeIds = new HashSet<string>(StringComparer.Ordinal);
        if (lensEvent.RuntimeMessage is not null)
        {
            noticeIds.Add(lensEvent.EventId);
        }

        return noticeIds;
    }

    private static string ResolveRequestId(LensPulseEvent lensEvent)
    {
        return string.IsNullOrWhiteSpace(lensEvent.RequestId)
            ? $"request:{lensEvent.EventId}"
            : lensEvent.RequestId;
    }

    private static string NormalizeItemType(string? itemType)
    {
        return (itemType ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "usermessage" => "user_message",
            _ => itemType ?? string.Empty
        };
    }

    private static string ResolveCanonicalItemId(
        IReadOnlyDictionary<string, LensPulseItemSummary> items,
        LensPulseEvent lensEvent,
        string transcriptKind)
    {
        if (transcriptKind == "user" &&
            TryFindLocalUserMessageItem(items, lensEvent.TurnId, out var localItemId))
        {
            return localItemId;
        }

        if (!string.IsNullOrWhiteSpace(lensEvent.ItemId))
        {
            return lensEvent.ItemId;
        }

        if (transcriptKind == "user" && !string.IsNullOrWhiteSpace(lensEvent.TurnId))
        {
            return $"local-user:{lensEvent.TurnId}";
        }

        return $"item:{lensEvent.EventId}";
    }

    private static string ResolveTranscriptEntryIdForItem(
        LensPulseEvent lensEvent,
        string transcriptKind,
        string canonicalItemId)
    {
        return transcriptKind switch
        {
            "assistant" => $"assistant:{canonicalItemId}",
            "user" when !string.IsNullOrWhiteSpace(lensEvent.TurnId) => $"user:{lensEvent.TurnId}",
            "user" => $"user:{canonicalItemId}",
            "tool" => $"tool:{canonicalItemId}",
            _ => $"{transcriptKind}:{canonicalItemId}"
        };
    }

    private static string ResolveTranscriptEntryIdForStream(
        LensConversationState state,
        LensPulseEvent lensEvent,
        string transcriptKind,
        string streamKind)
    {
        var turnId = lensEvent.TurnId ?? state.CurrentTurn.TurnId;
        return transcriptKind switch
        {
            "assistant" when !string.IsNullOrWhiteSpace(lensEvent.ItemId) => $"assistant:{lensEvent.ItemId}",
            "assistant" when !string.IsNullOrWhiteSpace(turnId) => $"assistant-stream:{turnId}",
            "assistant" => $"assistant-stream:{lensEvent.EventId}",
            "tool" when !string.IsNullOrWhiteSpace(lensEvent.ItemId) => $"tool:{lensEvent.ItemId}",
            "tool" => $"tool:{streamKind}:{turnId ?? lensEvent.EventId}",
            "reasoning" => $"reasoning:{streamKind}:{turnId ?? lensEvent.ItemId ?? lensEvent.EventId}",
            _ => $"{transcriptKind}:{turnId ?? lensEvent.ItemId ?? lensEvent.EventId}"
        };
    }

    private static string TranscriptKindFromItem(string itemType)
    {
        var normalized = itemType.Trim().ToLowerInvariant();
        if (normalized.Contains("assistant", StringComparison.Ordinal))
        {
            return "assistant";
        }

        if (normalized.Contains("user", StringComparison.Ordinal) ||
            normalized.Contains("input", StringComparison.Ordinal))
        {
            return "user";
        }

        return "tool";
    }

    private static string? TranscriptKindFromStream(string streamKind)
    {
        var normalized = streamKind.Trim().ToLowerInvariant();
        if (normalized == "assistant_text")
        {
            return "assistant";
        }

        if (normalized is "reasoning_text" or "reasoning_summary_text")
        {
            return "reasoning";
        }

        if (normalized is "command_output" or "file_change_output" ||
            normalized.EndsWith("_output", StringComparison.Ordinal) ||
            normalized.EndsWith("_result", StringComparison.Ordinal))
        {
            return "tool";
        }

        return null;
    }

    private static bool TryFindLocalUserMessageItem(
        IReadOnlyDictionary<string, LensPulseItemSummary> items,
        string? turnId,
        out string itemId)
    {
        if (!string.IsNullOrWhiteSpace(turnId))
        {
            foreach (var pair in items)
            {
                if (pair.Key.StartsWith("local-user:", StringComparison.Ordinal) &&
                    string.Equals(pair.Value.TurnId, turnId, StringComparison.Ordinal))
                {
                    itemId = pair.Key;
                    return true;
                }
            }
        }

        itemId = string.Empty;
        return false;
    }

    private static string ChoosePreferredUserMessageStatus(string? existingStatus, string? incomingStatus)
    {
        if (string.Equals(existingStatus, "completed", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(incomingStatus, "completed", StringComparison.OrdinalIgnoreCase))
        {
            return "completed";
        }

        return string.IsNullOrWhiteSpace(incomingStatus) ? existingStatus ?? string.Empty : incomingStatus;
    }

    private static string ResolveStreamTitle(string transcriptKind, string streamKind, string? existingTitle)
    {
        if (!string.IsNullOrWhiteSpace(existingTitle))
        {
            return existingTitle;
        }

        return (transcriptKind, streamKind) switch
        {
            ("reasoning", "reasoning_summary_text") => "Reasoning summary",
            ("reasoning", _) => "Reasoning",
            ("tool", "command_output") => "Command output",
            ("tool", "file_change_output") => "File change output",
            _ => string.Empty
        };
    }

    private static string BuildRequestBody(LensPulseRequestSummary request)
    {
        var sections = new List<string>();
        if (!string.IsNullOrWhiteSpace(request.Detail))
        {
            sections.Add(request.Detail.Trim());
        }

        if (request.Questions.Count > 0)
        {
            sections.Add(string.Join(
                "\n",
                request.Questions.Select(static question => question.Question)
                    .Where(static question => !string.IsNullOrWhiteSpace(question))));
        }

        if (request.Answers.Count > 0)
        {
            sections.Add(string.Join(
                "\n",
                request.Answers.Select(static answer => $"{answer.QuestionId}: {string.Join(", ", answer.Answers)}")));
        }

        if (!string.IsNullOrWhiteSpace(request.Decision))
        {
            sections.Add($"Decision: {request.Decision}");
        }

        return string.Join("\n\n", sections.Where(static section => !string.IsNullOrWhiteSpace(section)));
    }

    private static string MergeProgressiveMessage(string? existing, string? incoming)
    {
        var normalizedExisting = NormalizeTranscriptText(existing);
        var normalizedIncoming = NormalizeTranscriptText(incoming);
        var trimmedExisting = normalizedExisting.Trim();
        if (string.IsNullOrWhiteSpace(trimmedExisting))
        {
            return normalizedIncoming;
        }

        if (trimmedExisting == normalizedIncoming)
        {
            return trimmedExisting;
        }

        if (normalizedIncoming.Contains(trimmedExisting, StringComparison.Ordinal))
        {
            return normalizedIncoming;
        }

        if (trimmedExisting.Contains(normalizedIncoming, StringComparison.Ordinal))
        {
            return trimmedExisting;
        }

        var overlapLength = FindMessageOverlap(trimmedExisting, normalizedIncoming);
        if (overlapLength > 0)
        {
            return $"{trimmedExisting}{normalizedIncoming[overlapLength..]}";
        }

        return AppendTranscriptChunk(trimmedExisting, normalizedIncoming);
    }

    private static string AppendAssistantDelta(string? existing, string? delta)
    {
        return $"{NormalizeTranscriptText(existing)}{NormalizeTranscriptText(delta)}";
    }

    private static int FindMessageOverlap(string left, string right)
    {
        var maxOverlap = Math.Min(left.Length, right.Length);
        for (var overlap = maxOverlap; overlap > 0; overlap--)
        {
            if (string.Equals(left[^overlap..], right[..overlap], StringComparison.Ordinal))
            {
                return overlap;
            }
        }

        return 0;
    }

    private static string MergeTranscriptBody(string? existing, string? incoming)
    {
        var normalizedExisting = NormalizeTranscriptText(existing);
        var normalizedIncoming = NormalizeTranscriptText(incoming);
        if (string.IsNullOrWhiteSpace(normalizedIncoming))
        {
            return normalizedExisting;
        }

        if (string.IsNullOrWhiteSpace(normalizedExisting))
        {
            return normalizedIncoming;
        }

        if (string.Equals(normalizedExisting, normalizedIncoming, StringComparison.Ordinal))
        {
            return normalizedExisting;
        }

        if (normalizedIncoming.Contains(normalizedExisting, StringComparison.Ordinal))
        {
            return normalizedIncoming;
        }

        if (normalizedExisting.Contains(normalizedIncoming, StringComparison.Ordinal))
        {
            return normalizedExisting;
        }

        return AppendTranscriptChunk(normalizedExisting, normalizedIncoming);
    }

    private static string AppendTranscriptChunk(string? existing, string? chunk)
    {
        var normalizedExisting = NormalizeTranscriptText(existing);
        var normalizedChunk = NormalizeTranscriptText(chunk);
        if (string.IsNullOrWhiteSpace(normalizedChunk))
        {
            return normalizedExisting;
        }

        if (string.IsNullOrWhiteSpace(normalizedExisting))
        {
            return normalizedChunk;
        }

        if (normalizedExisting.EndsWith('\n') || normalizedChunk.StartsWith('\n'))
        {
            return normalizedExisting + normalizedChunk;
        }

        return $"{normalizedExisting}\n{normalizedChunk}";
    }

    private static string NormalizeTranscriptText(string? value)
    {
        return (value ?? string.Empty).Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
    }

    private static string PreferNonEmpty(string? incoming, string? fallback)
    {
        return string.IsNullOrWhiteSpace(incoming) ? fallback ?? string.Empty : incoming;
    }

    private static string? PreferMeaningfulText(string? existing, string? incoming)
    {
        if (!string.IsNullOrWhiteSpace(incoming))
        {
            return NormalizeTranscriptText(incoming).Trim();
        }

        return string.IsNullOrWhiteSpace(existing) ? null : existing;
    }

    private static string? PreferNonGenericText(string? existing, string? incoming)
    {
        if (!string.IsNullOrWhiteSpace(incoming))
        {
            return incoming;
        }

        return existing;
    }

    private static bool IsTerminalStatus(string? status)
    {
        return string.Equals(status, "completed", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(status, "resolved", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(status, "error", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(status, "cancelled", StringComparison.OrdinalIgnoreCase);
    }

    private static List<LensAttachmentReference> CloneAttachments(
        IReadOnlyList<LensAttachmentReference>? attachments)
    {
        if (attachments is null || attachments.Count == 0)
        {
            return [];
        }

        return attachments.Select(static attachment => new LensAttachmentReference
        {
            Kind = attachment.Kind,
            Path = attachment.Path,
            MimeType = attachment.MimeType,
            DisplayName = string.IsNullOrWhiteSpace(attachment.DisplayName)
                ? Path.GetFileName(attachment.Path)
                : attachment.DisplayName
        }).ToList();
    }

    private static List<LensAttachmentReference> MergeAttachments(
        IReadOnlyList<LensAttachmentReference>? existing,
        IReadOnlyList<LensAttachmentReference>? incoming)
    {
        if ((existing is null || existing.Count == 0) && (incoming is null || incoming.Count == 0))
        {
            return [];
        }

        var merged = CloneAttachments(existing);
        foreach (var attachment in CloneAttachments(incoming))
        {
            if (merged.Any(existingAttachment =>
                    string.Equals(existingAttachment.Kind, attachment.Kind, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(existingAttachment.Path, attachment.Path, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(existingAttachment.DisplayName, attachment.DisplayName, StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            merged.Add(attachment);
        }

        return merged;
    }

    private static LensPulseTranscriptEntry EnsureTranscriptEntry(
        LensConversationState state,
        string entryId,
        string kind,
        DateTimeOffset createdAt)
    {
        if (!state.TranscriptEntries.TryGetValue(entryId, out var entry))
        {
            entry = new LensPulseTranscriptEntry
            {
                EntryId = entryId,
                Order = ++state.NextTranscriptOrder,
                Kind = kind,
                CreatedAt = createdAt,
                UpdatedAt = createdAt
            };
            state.TranscriptEntries[entryId] = entry;
        }

        entry.Kind = kind;
        if (entry.UpdatedAt < createdAt)
        {
            entry.UpdatedAt = createdAt;
        }

        return entry;
    }

    private static void CompleteStreamingTranscriptEntries(LensConversationState state, string? turnId)
    {
        foreach (var entry in state.TranscriptEntries.Values)
        {
            if (!entry.Streaming)
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(turnId) &&
                !string.Equals(entry.TurnId, turnId, StringComparison.Ordinal))
            {
                continue;
            }

            entry.Streaming = false;
            if (string.IsNullOrWhiteSpace(entry.Status) ||
                string.Equals(entry.Status, "streaming", StringComparison.OrdinalIgnoreCase))
            {
                entry.Status = "completed";
            }
        }
    }

    private static void ResetStreams(LensPulseStreamsSummary streams)
    {
        streams.AssistantText = string.Empty;
        streams.ReasoningText = string.Empty;
        streams.ReasoningSummaryText = string.Empty;
        streams.PlanText = string.Empty;
        streams.CommandOutput = string.Empty;
        streams.FileChangeOutput = string.Empty;
        streams.UnifiedDiff = string.Empty;
    }

    private static LensScreenLogHistoryEntry BuildScreenLogHistoryEntry(LensPulseTranscriptEntry entry)
    {
        var kind = NormalizeHistoryKind(entry.Kind);
        var statusLabel = entry.Streaming
            ? "Streaming"
            : Prettify(entry.Status);
        var collapsedByDefault = ShouldCollapseHistoryBodyByDefault(entry, kind);

        return new LensScreenLogHistoryEntry
        {
            EntryId = entry.EntryId,
            Order = entry.Order,
            Kind = kind,
            ItemType = entry.ItemType,
            Status = entry.Status,
            Label = ResolveHistoryLabel(kind),
            Title = entry.Title ?? string.Empty,
            Meta = FormatHistoryMeta(kind, statusLabel, entry.UpdatedAt),
            Body = entry.Body,
            RenderMode = ResolveHistoryRenderMode(kind, entry.Streaming),
            CollapsedByDefault = collapsedByDefault,
            Preview = BuildHistoryPreview(entry.Body),
            LineCount = CountHistoryBodyLines(entry.Body),
            Streaming = entry.Streaming,
            UpdatedAt = entry.UpdatedAt,
            Attachments = CloneAttachments(entry.Attachments)
        };
    }

    private static string NormalizeHistoryKind(string? kind)
    {
        return string.IsNullOrWhiteSpace(kind) ? "system" : kind.Trim().ToLowerInvariant();
    }

    private static string ResolveHistoryLabel(string kind)
    {
        return kind switch
        {
            "user" => "You",
            "assistant" => "Assistant",
            "reasoning" => "Reasoning",
            "tool" => "Tool",
            "request" => "Request",
            "plan" => "Plan",
            "diff" => "Diff",
            "notice" => "Error",
            _ => "System"
        };
    }

    private static string ResolveHistoryRenderMode(string kind, bool streaming)
    {
        if (kind == "assistant")
        {
            return streaming ? "streaming_text" : "markdown";
        }

        return kind is "tool" or "reasoning" or "plan" or "diff" ? "monospace" : "plain";
    }

    private static bool ShouldCollapseHistoryBodyByDefault(LensPulseTranscriptEntry entry, string kind)
    {
        if (entry.Streaming || kind is not ("tool" or "reasoning" or "plan" or "diff"))
        {
            return false;
        }

        var lineCount = CountHistoryBodyLines(entry.Body);
        return lineCount >= CollapsibleHistoryBodyMinLines || entry.Body.Length >= CollapsibleHistoryBodyMinChars;
    }

    private static int CountHistoryBodyLines(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return 0;
        }

        return NormalizeTranscriptText(body).Split('\n').Length;
    }

    private static string BuildHistoryPreview(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return string.Empty;
        }

        var firstContentLine = NormalizeTranscriptText(body)
            .Split('\n')
            .Select(static line => line.Trim())
            .FirstOrDefault(static line => !string.IsNullOrWhiteSpace(line))
            ?? string.Empty;
        var singleLine = string.Join(
            " ",
            firstContentLine.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (singleLine.Length <= HistoryPreviewMaxChars)
        {
            return singleLine;
        }

        return singleLine[..(HistoryPreviewMaxChars - 1)] + "…";
    }

    private static string Prettify(string? value)
    {
        return (value ?? string.Empty)
            .Replace("_", " ", StringComparison.Ordinal)
            .Replace(".", " ", StringComparison.Ordinal)
            .Replace("/", " ", StringComparison.Ordinal)
            .Replace("-", " ", StringComparison.Ordinal)
            .Trim() switch
        {
            "" => string.Empty,
            var normalized => string.Join(
                ' ',
                normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries)
                    .Select(static part => char.ToUpperInvariant(part[0]) + part[1..].ToLowerInvariant()))
        };
    }

    private static string FormatHistoryMeta(string kind, string statusLabel, DateTimeOffset value)
    {
        var timeText = value.ToString("HH:mm:ss");
        var normalizedStatus = statusLabel.Trim();
        if (string.IsNullOrWhiteSpace(normalizedStatus) || ShouldHideStatusInMeta(kind, normalizedStatus))
        {
            return timeText;
        }

        return $"{normalizedStatus} • {timeText}";
    }

    private static bool ShouldHideStatusInMeta(string kind, string statusLabel)
    {
        var normalizedStatus = statusLabel.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(normalizedStatus))
        {
            return true;
        }

        if (kind is "user" or "assistant")
        {
            return normalizedStatus is "completed" or "updated" or "assistant text" or "snapshot";
        }

        if (kind is "tool" or "reasoning" or "plan" or "diff")
        {
            return normalizedStatus is "completed" or "updated";
        }

        return false;
    }

    private sealed class SessionLensPulseLog
    {
        public SessionLensPulseLog(string sessionId)
        {
            SessionId = sessionId;
        }

        public string SessionId { get; }
        public Lock SyncRoot { get; } = new();
        public long NextSequence { get; set; }
        public List<LensPulseEvent> Events { get; } = [];
        public List<LensPulseSubscriber> Subscribers { get; } = [];
        public List<LensPulseDeltaSubscriber> DeltaSubscribers { get; } = [];
        public LensConversationState State { get; } = new();
        public string? ScreenLogId { get; set; }
        public string? ScreenLogPath { get; set; }
    }

    private sealed class LensConversationState
    {
        public string Provider { get; set; } = string.Empty;
        public LensPulseSessionSummary Session { get; } = new();
        public LensPulseThreadSummary Thread { get; } = new();
        public LensPulseTurnSummary CurrentTurn { get; } = new();
        public LensPulseStreamsSummary Streams { get; } = new();
        public Dictionary<string, LensPulseTranscriptEntry> TranscriptEntries { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, LensPulseItemSummary> Items { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, LensPulseRequestSummary> Requests { get; } = new(StringComparer.Ordinal);
        public List<LensPulseRuntimeNotice> Notices { get; } = [];
        public long NextTranscriptOrder { get; set; }
    }

    private sealed class LensPulseSubscriber(ChannelWriter<LensPulseEvent> writer)
    {
        public ChannelWriter<LensPulseEvent> Writer { get; } = writer;
    }

    private sealed class LensPulseDeltaSubscriber(ChannelWriter<LensPulseDeltaResponse> writer)
    {
        public ChannelWriter<LensPulseDeltaResponse> Writer { get; } = writer;
    }

    private sealed class LensScreenLogHeaderRecord
    {
        public string Format { get; init; } = ScreenLogFormatVersion;
        public string RecordType { get; init; } = "header";
        public string LogId { get; init; } = string.Empty;
        public string SessionId { get; init; } = string.Empty;
        public string Provider { get; init; } = string.Empty;
        public DateTimeOffset CreatedAt { get; init; }
    }

    private sealed class LensScreenLogDeltaRecord
    {
        public string Format { get; init; } = ScreenLogFormatVersion;
        public string RecordType { get; init; } = "screen_delta";
        public string LogId { get; init; } = string.Empty;
        public string SessionId { get; init; } = string.Empty;
        public string Provider { get; init; } = string.Empty;
        public long LatestSequence { get; init; }
        public DateTimeOffset RecordedAt { get; init; }
        public LensScreenLogSessionState Session { get; init; } = new();
        public LensScreenLogTurnState CurrentTurn { get; init; } = new();
        public List<LensScreenLogHistoryEntry> HistoryUpserts { get; init; } = [];
        public List<string> HistoryRemovals { get; init; } = [];
    }

    private sealed class LensScreenLogSessionState
    {
        public string State { get; init; } = string.Empty;
        public string StateLabel { get; init; } = string.Empty;
        public string? Reason { get; init; }
        public string? LastError { get; init; }
    }

    private sealed class LensScreenLogTurnState
    {
        public string? TurnId { get; init; }
        public string State { get; init; } = string.Empty;
        public string StateLabel { get; init; } = string.Empty;
        public string? Model { get; init; }
        public string? Effort { get; init; }
    }

    private sealed class LensScreenLogHistoryEntry
    {
        public string EntryId { get; init; } = string.Empty;
        public long Order { get; init; }
        public string Kind { get; init; } = string.Empty;
        public string? ItemType { get; init; }
        public string Status { get; init; } = string.Empty;
        public string Label { get; init; } = string.Empty;
        public string Title { get; init; } = string.Empty;
        public string Meta { get; init; } = string.Empty;
        public string Body { get; init; } = string.Empty;
        public string RenderMode { get; init; } = string.Empty;
        public bool CollapsedByDefault { get; init; }
        public string Preview { get; init; } = string.Empty;
        public int LineCount { get; init; }
        public bool Streaming { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public List<LensAttachmentReference> Attachments { get; init; } = [];
    }

    [JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
    [JsonSerializable(typeof(LensScreenLogHeaderRecord))]
    [JsonSerializable(typeof(LensScreenLogDeltaRecord))]
    private sealed partial class LensScreenLogJsonContext : JsonSerializerContext;
}

public sealed class LensPulseSubscription : IDisposable
{
    private readonly Action _dispose;
    private int _disposed;

    public LensPulseSubscription(ChannelReader<LensPulseEvent> reader, Action dispose)
    {
        Reader = reader;
        _dispose = dispose;
    }

    public ChannelReader<LensPulseEvent> Reader { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _dispose();
        }
    }
}

public sealed class LensPulseDeltaSubscription : IDisposable
{
    private readonly Action _dispose;
    private int _disposed;

    public LensPulseDeltaSubscription(ChannelReader<LensPulseDeltaResponse> reader, Action dispose)
    {
        Reader = reader;
        _dispose = dispose;
    }

    public ChannelReader<LensPulseDeltaResponse> Reader { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _dispose();
        }
    }
}
