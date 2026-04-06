using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
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
    private const int MaxVisibleDiffScreenLogLines = 200;
    private const int MaxVisibleCommandOutputLines = 10;
    private const int MaxAssistantStreamChars = 262144;
    private const int MaxReasoningStreamChars = 8192;
    private const int MaxReasoningSummaryStreamChars = 8192;
    private const int MaxPlanStreamChars = 16384;
    private const int MaxCommandOutputStreamChars = 16384;
    private const int MaxFileChangeOutputStreamChars = 16384;
    private const int MaxUnifiedDiffChars = 32768;
    private const int MaxToolRawOutputChars = 16384;
    private const int MaxHistoryBodyChars = 4096;
    private const int MaxHistoryLineChars = 512;
    private const string TailRetentionMarker = "... earlier output omitted ...";
    private const string HeadRetentionMarker = "... output truncated ...";
    private readonly ConcurrentDictionary<string, SessionLensPulseLog> _logs = new(StringComparer.Ordinal);
    private readonly string _storeDirectory;
    private readonly bool _screenLoggingEnabled;
    private readonly string? _screenLogDirectory;

    [GeneratedRegex("-Command\\s+(?:'(?<cmd>[^']+)'|\"(?<cmd>[^\"]+)\"|(?<cmd>.+))", RegexOptions.IgnoreCase, 1000)]
    private static partial Regex InlineCommandRegex();

    [GeneratedRegex("^(?:Get-Content|cat|type)\\s+(?:-[^\\s]+\\s+)*(?:'(?<path>[^']+)'|\"(?<path>[^\"]+)\"|(?<path>\\S+))", RegexOptions.IgnoreCase, 1000)]
    private static partial Regex ReadFileTargetRegex();

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

        var retainedEvent = LensEventCompaction.CloneForRetention(lensEvent);
        var log = GetOrLoadLog(lensEvent.SessionId);
        lock (log.SyncRoot)
        {
            retainedEvent.Sequence = ++log.NextSequence;
            log.Events.Add(retainedEvent);
            ApplyEvent(log.State, retainedEvent);
            var delta = BuildDelta(log.SessionId, log.NextSequence, log.State, retainedEvent);
            PersistEvent(log.SessionId, retainedEvent);
            PersistScreenLogDelta(log, delta);

            var staleSubscribers = new List<LensPulseSubscriber>();
            foreach (var subscriber in log.Subscribers)
            {
                if (!subscriber.Writer.TryWrite(CloneEvent(retainedEvent)))
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

        var state = new SubscriptionState(
            () =>
            {
                lock (log.SyncRoot)
                {
                    log.Subscribers.Remove(subscriber);
                }

                channel.Writer.TryComplete();
            });
        var subscription = new LensPulseSubscription(channel.Reader, state);

        if (cancellationToken.CanBeCanceled)
        {
            cancellationToken.Register(static state =>
            {
                if (state is SubscriptionState subscriptionState)
                {
                    subscriptionState.Close();
                }
            }, state);
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

        var state = new SubscriptionState(
            () =>
            {
                lock (log.SyncRoot)
                {
                    log.DeltaSubscribers.Remove(subscriber);
                }

                channel.Writer.TryComplete();
            });
        var subscription = new LensPulseDeltaSubscription(channel.Reader, state);

        if (cancellationToken.CanBeCanceled)
        {
            cancellationToken.Register(static state =>
            {
                if (state is SubscriptionState subscriptionState)
                {
                    subscriptionState.Close();
                }
            }, state);
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

    public SessionLensHeatSnapshot GetHeatSnapshot(string sessionId)
    {
        if (!TryGetLog(sessionId, out var log))
        {
            return SessionLensHeatSnapshot.Cold;
        }

        lock (log.SyncRoot)
        {
            return BuildHeatSnapshot(log.State);
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

            var retainedEvent = LensEventCompaction.CloneForRetention(lensEvent);
            log.Events.Add(retainedEvent);
            log.NextSequence = Math.Max(log.NextSequence, retainedEvent.Sequence);
            ApplyEvent(log.State, retainedEvent);
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
                .Where(ShouldIncludeInScreenHistoryLog)
                .Select(BuildScreenLogHistoryEntry)
                .OrderBy(entry => entry.Order)
                .ToList(),
            HistoryRemovals = [.. delta.HistoryRemovals]
        };

        var signature = BuildScreenLogSignature(record);
        if (string.Equals(signature, log.LastScreenLogSignature, StringComparison.Ordinal))
        {
            return;
        }

        log.LastScreenLogSignature = signature;

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

        if (lensEvent.QuickSettingsUpdated is not null)
        {
            ApplyQuickSettingsUpdate(state, lensEvent);
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
            QuickSettings = CloneQuickSettingsSummary(state.QuickSettings),
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

    private static SessionLensHeatSnapshot BuildHeatSnapshot(LensConversationState state)
    {
        if (!ShouldSurfaceWorkingHeat(state))
        {
            return SessionLensHeatSnapshot.Cold;
        }

        return new SessionLensHeatSnapshot
        {
            CurrentHeat = 1,
            LastActivityAt = state.Session.LastEventAt ?? state.CurrentTurn.StartedAt
        };
    }

    private static bool ShouldSurfaceWorkingHeat(LensConversationState state)
    {
        if (state.Requests.Values.Any(static request => string.Equals(request.State, "open", StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        if (IsWorkingTurnState(state.CurrentTurn.State))
        {
            return true;
        }

        return string.IsNullOrWhiteSpace(state.CurrentTurn.State) &&
               IsWorkingSessionState(state.Session.State);
    }

    private static bool IsWorkingTurnState(string? state)
    {
        return state?.Trim().ToLowerInvariant() switch
        {
            "running" => true,
            "in_progress" => true,
            "started" => true,
            _ => false
        };
    }

    private static bool IsWorkingSessionState(string? state)
    {
        return state?.Trim().ToLowerInvariant() switch
        {
            "starting" => true,
            "running" => true,
            _ => false
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
            QuickSettings = CloneQuickSettingsSummary(state.QuickSettings),
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
        state.QuickSettings.Model = LensQuickSettings.NormalizeOptionalValue(lensEvent.TurnStarted?.Model);
        state.QuickSettings.Effort = LensQuickSettings.NormalizeOptionalValue(lensEvent.TurnStarted?.Effort);
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

    private static void ApplyQuickSettingsUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        var quickSettings = lensEvent.QuickSettingsUpdated;
        if (quickSettings is null)
        {
            return;
        }

        state.QuickSettings.Model = LensQuickSettings.NormalizeOptionalValue(quickSettings.Model);
        state.QuickSettings.Effort = LensQuickSettings.NormalizeOptionalValue(quickSettings.Effort);
        state.QuickSettings.PlanMode = LensQuickSettings.NormalizePlanMode(quickSettings.PlanMode);
        state.QuickSettings.PermissionMode = LensQuickSettings.NormalizePermissionMode(quickSettings.PermissionMode);
    }

    private static void ApplyPlanUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.PlanDelta?.Delta))
        {
            state.Streams.PlanText = AppendRetainedTranscriptChunk(
                state.Streams.PlanText,
                lensEvent.PlanDelta.Delta,
                MaxPlanStreamChars,
                retainHead: false);
        }

        if (!string.IsNullOrWhiteSpace(lensEvent.PlanCompleted?.PlanMarkdown))
        {
            state.Streams.PlanText = RetainWithinBudget(
                NormalizeTranscriptText(lensEvent.PlanCompleted.PlanMarkdown),
                MaxPlanStreamChars,
                retainHead: false);
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
            ? RetainWithinBudget(NormalizeTranscriptText(lensEvent.PlanCompleted.PlanMarkdown), MaxPlanStreamChars, retainHead: false)
            : AppendRetainedTranscriptChunk(entry.Body, lensEvent.PlanDelta?.Delta, MaxPlanStreamChars, retainHead: false);
        entry.Streaming = false;
        entry.UpdatedAt = lensEvent.CreatedAt;
    }

    private static void ApplyDiffUpdate(LensConversationState state, LensPulseEvent lensEvent)
    {
        state.Streams.UnifiedDiff = RetainWithinBudget(
            NormalizeTranscriptText(lensEvent.DiffUpdated?.UnifiedDiff),
            MaxUnifiedDiffChars,
            retainHead: false);
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
                state.Streams.ReasoningText = AppendRetainedTranscriptChunk(
                    state.Streams.ReasoningText,
                    lensEvent.ContentDelta.Delta,
                    MaxReasoningStreamChars,
                    retainHead: false);
                break;
            case "reasoning_summary_text":
                state.Streams.ReasoningSummaryText = AppendRetainedTranscriptChunk(
                    state.Streams.ReasoningSummaryText,
                    lensEvent.ContentDelta.Delta,
                    MaxReasoningSummaryStreamChars,
                    retainHead: false);
                break;
            case "plan_text":
                state.Streams.PlanText = AppendRetainedTranscriptChunk(
                    state.Streams.PlanText,
                    lensEvent.ContentDelta.Delta,
                    MaxPlanStreamChars,
                    retainHead: false);
                break;
            case "command_output":
                state.Streams.CommandOutput = AppendRetainedTranscriptChunk(
                    state.Streams.CommandOutput,
                    lensEvent.ContentDelta.Delta,
                    MaxCommandOutputStreamChars,
                    retainHead: false);
                break;
            case "file_change_output":
                state.Streams.FileChangeOutput = AppendRetainedTranscriptChunk(
                    state.Streams.FileChangeOutput,
                    lensEvent.ContentDelta.Delta,
                    MaxFileChangeOutputStreamChars,
                    retainHead: false);
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
        if (transcriptKind == "assistant")
        {
            entry.Title = ResolveStreamTitle(transcriptKind, lensEvent.ContentDelta.StreamKind, entry.Title);
            entry.Body = AppendAssistantDelta(entry.Body, lensEvent.ContentDelta.Delta);
            entry.Streaming = true;
        }
        else if (transcriptKind == "tool")
        {
            var toolState = GetOrCreateToolRenderState(state, entry.EntryId);
            toolState.RawOutput = AppendRetainedToolOutput(
                toolState.RawOutput,
                lensEvent.ContentDelta.Delta,
                toolState.RetainHeadOutput);
            entry.Title = ResolveToolEntryTitle(
                lensEvent.ContentDelta.StreamKind,
                entry.Title,
                toolState.CommandText);
            entry.Body = BuildToolScreenBody(
                lensEvent.ContentDelta.StreamKind,
                toolState.CommandText,
                toolState.RawOutput,
                streaming: true);
            entry.Streaming = true;
        }
        else
        {
            entry.Title = ResolveStreamTitle(transcriptKind, lensEvent.ContentDelta.StreamKind, entry.Title);
            entry.Body = AppendTranscriptChunk(entry.Body, lensEvent.ContentDelta.Delta);
            entry.Streaming = true;
        }

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

    private static LensToolRenderState GetOrCreateToolRenderState(
        LensConversationState state,
        string entryId)
    {
        if (!state.ToolRenderStates.TryGetValue(entryId, out var toolState))
        {
            toolState = new LensToolRenderState();
            state.ToolRenderStates[entryId] = toolState;
        }

        return toolState;
    }

    private static string? ResolveToolEntryTitle(
        string? itemType,
        string? incomingTitle,
        string? commandText)
    {
        var normalizedType = NormalizeItemType(itemType);
        var normalizedTitle = PreferMeaningfulText(null, incomingTitle);
        var commandSummary = SummarizeCommandText(commandText);

        return normalizedType switch
        {
            "command_execution" or "command_output"
                => string.IsNullOrWhiteSpace(commandSummary) && !string.IsNullOrWhiteSpace(normalizedTitle)
                    ? normalizedTitle
                    : TryExtractReadFileTarget(commandSummary, out _) ? "Read file" : "Run command",
            "file_change_output" => "File change output",
            "reasoning" => "Reasoning",
            "reasoning_summary_text" => "Reasoning summary",
            _ => IsGenericToolTitle(normalizedTitle)
                ? Prettify(normalizedType)
                : normalizedTitle
        };
    }

    private static bool IsGenericToolTitle(string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        return normalized is "" or "tool started" or "tool completed" or "command running";
    }

    private static string BuildToolScreenBody(
        string? itemType,
        string? commandText,
        string? detail,
        bool streaming)
    {
        var normalizedType = NormalizeItemType(itemType);
        return normalizedType switch
        {
            "command_execution" => BuildCommandInvocationBody(commandText, detail),
            "command_output" => BuildCommandOutputBody(commandText, detail, streaming),
            "file_change_output" => BuildFileChangeOutputBody(commandText, detail, streaming),
            _ => NormalizeTranscriptText(detail).Trim()
        };
    }

    private static string BuildCommandInvocationBody(string? commandText, string? detail)
    {
        var command = SummarizeCommandText(commandText);
        if (!string.IsNullOrWhiteSpace(command))
        {
            return command;
        }

        return NormalizeTranscriptText(detail).Trim();
    }

    private static string BuildCommandOutputBody(string? commandText, string? rawOutput, bool streaming)
    {
        var normalizedOutput = NormalizeTranscriptText(rawOutput).Trim('\n');
        var command = SummarizeCommandText(commandText);
        if (TryExtractReadFileTarget(command, out var filePath))
        {
            return BuildWindowedOutputBody(
                filePath,
                normalizedOutput,
                takeHead: true,
                streaming: streaming);
        }

        return BuildWindowedOutputBody(command, normalizedOutput, takeHead: false, streaming: streaming);
    }

    private static string BuildFileChangeOutputBody(string? commandText, string? rawOutput, bool streaming)
    {
        return BuildWindowedOutputBody(
            SummarizeCommandText(commandText),
            NormalizeTranscriptText(rawOutput).Trim('\n'),
            takeHead: false,
            streaming: streaming);
    }

    private static string BuildWindowedOutputBody(
        string? header,
        string output,
        bool takeHead,
        bool streaming)
    {
        var lines = output.Length == 0 ? [] : output.Split('\n');
        var visibleLines = lines;
        var omittedLineCount = 0;
        if (lines.Length > MaxVisibleCommandOutputLines)
        {
            omittedLineCount = lines.Length - MaxVisibleCommandOutputLines;
            visibleLines = takeHead
                ? lines.Take(MaxVisibleCommandOutputLines).ToArray()
                : lines.Skip(lines.Length - MaxVisibleCommandOutputLines).ToArray();
        }

        var sections = new List<string>();
        if (!string.IsNullOrWhiteSpace(header))
        {
            sections.Add(header.Trim());
        }

        if (visibleLines.Length > 0)
        {
            if (!string.IsNullOrWhiteSpace(header))
            {
                sections.Add(string.Empty);
            }

            if (omittedLineCount > 0 && !takeHead)
            {
                sections.Add(string.Create(CultureInfo.InvariantCulture, $"... {omittedLineCount} earlier lines omitted ..."));
            }

            sections.AddRange(visibleLines.Select(CompactHistoryLine));

            if (omittedLineCount > 0 && takeHead)
            {
                sections.Add(string.Empty);
                sections.Add(string.Create(CultureInfo.InvariantCulture, $"... {omittedLineCount} more lines omitted ..."));
            }
        }
        else if (streaming && !string.IsNullOrWhiteSpace(header))
        {
            sections.Add(string.Empty);
            sections.Add("Waiting for output...");
        }

        return CompactHistoryBody(string.Join("\n", sections), takeHead);
    }

    private static string SummarizeCommandText(string? value)
    {
        var normalized = NormalizeTranscriptText(value).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return string.Empty;
        }

        if (TryExtractInlineCommand(normalized, out var inlineCommand))
        {
            normalized = inlineCommand;
        }

        return normalized;
    }

    private static string? ExtractCommandText(string? value)
    {
        var normalized = NormalizeTranscriptText(value).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return null;
        }

        return TryExtractInlineCommand(normalized, out var inlineCommand)
            ? inlineCommand
            : normalized;
    }

    private static bool TryExtractInlineCommand(string value, out string command)
    {
        command = string.Empty;
        var commandMatch = InlineCommandRegex().Match(value);
        if (commandMatch.Success)
        {
            command = commandMatch.Groups["cmd"].Value.Trim();
            return !string.IsNullOrWhiteSpace(command);
        }

        return false;
    }

    private static bool TryExtractReadFileTarget(string? commandText, out string filePath)
    {
        filePath = string.Empty;
        if (string.IsNullOrWhiteSpace(commandText))
        {
            return false;
        }

        var match = ReadFileTargetRegex().Match(commandText);
        if (!match.Success)
        {
            return false;
        }

        filePath = match.Groups["path"].Value.Trim();
        return !string.IsNullOrWhiteSpace(filePath);
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
            "assistant" => MergeAssistantItemDetail(item.Detail, lensEvent.Item.Detail, lensEvent.Item.Status),
            "user" => PreferMeaningfulText(item.Detail, lensEvent.Item.Detail),
            _ => MergeTranscriptBody(item.Detail, lensEvent.Item.Detail)
        };
        item.Attachments = MergeAttachments(item.Attachments, lensEvent.Item.Attachments);
        item.UpdatedAt = lensEvent.CreatedAt;

        var entry = EnsureTranscriptEntry(
            state,
            ResolveTranscriptEntryIdForItem(state, lensEvent, transcriptKind, canonicalItemId),
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
                PromoteUserTranscriptEntryToTurnLead(state, entry);
                break;
            case "assistant":
                entry.Title = null;
                entry.Body = MergeAssistantItemDetail(entry.Body, lensEvent.Item.Detail, item.Status);
                entry.Streaming = !IsTerminalStatus(item.Status);
                break;
            case "reasoning":
            case "plan":
                entry.Title = PreferMeaningfulText(entry.Title, lensEvent.Item.Title);
                entry.Body = MergeTranscriptBody(entry.Body, lensEvent.Item.Detail);
                entry.Streaming = !IsTerminalStatus(item.Status);
                item.Detail = entry.Body;
                break;
            default:
                var toolState = GetOrCreateToolRenderState(state, entry.EntryId);
                if (normalizedType == "command_execution")
                {
                    toolState.CommandText = PreferMeaningfulText(
                        toolState.CommandText,
                        ExtractCommandText(lensEvent.Item.Detail)) ?? string.Empty;
                    toolState.RetainHeadOutput = TryExtractReadFileTarget(toolState.CommandText, out _);
                }
                else if (normalizedType is "command_output" or "file_change_output")
                {
                    toolState.RawOutput = AppendRetainedToolOutput(
                        toolState.RawOutput,
                        lensEvent.Item.Detail,
                        toolState.RetainHeadOutput);
                }

                entry.Title = ResolveToolEntryTitle(normalizedType, lensEvent.Item.Title, toolState.CommandText);
                entry.Body = BuildToolScreenBody(
                    normalizedType,
                    toolState.CommandText,
                    normalizedType is "command_output" or "file_change_output"
                        ? toolState.RawOutput
                        : MergeTranscriptBody(entry.Body, lensEvent.Item.Detail),
                    streaming: !IsTerminalStatus(item.Status));
                entry.Streaming = !IsTerminalStatus(item.Status);
                item.Detail = entry.Body;
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

        var entry = EnsureTranscriptEntry(
            state,
            $"runtime:{lensEvent.EventId}",
            RuntimeTranscriptKindFromEventType(lensEvent.Type),
            lensEvent.CreatedAt);
        entry.Status = RuntimeTranscriptStatusFromEventType(lensEvent.Type);
        entry.Title = RuntimeTranscriptTitleFromEventType(lensEvent.Type);
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
            QuickSettingsUpdated = source.QuickSettingsUpdated is null ? null : new LensPulseQuickSettingsPayload
            {
                Model = source.QuickSettingsUpdated.Model,
                Effort = source.QuickSettingsUpdated.Effort,
                PlanMode = LensQuickSettings.NormalizePlanMode(source.QuickSettingsUpdated.PlanMode),
                PermissionMode = LensQuickSettings.NormalizePermissionMode(source.QuickSettingsUpdated.PermissionMode)
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
            QuickSettings = CloneQuickSettingsSummary(source.QuickSettings),
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

    private static LensQuickSettingsSummary CloneQuickSettingsSummary(LensQuickSettingsSummary source)
    {
        return new LensQuickSettingsSummary
        {
            Model = LensQuickSettings.NormalizeOptionalValue(source.Model),
            Effort = LensQuickSettings.NormalizeOptionalValue(source.Effort),
            PlanMode = LensQuickSettings.NormalizePlanMode(source.PlanMode),
            PermissionMode = LensQuickSettings.NormalizePermissionMode(source.PermissionMode)
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
            historyIds.Add(ResolveTranscriptEntryIdForItem(state, lensEvent, transcriptKind, canonicalItemId));
        }

        if (lensEvent.RequestOpened is not null ||
            lensEvent.RequestResolved is not null ||
            lensEvent.UserInputRequested is not null ||
            lensEvent.UserInputResolved is not null)
        {
            historyIds.Add($"request:{ResolveRequestId(lensEvent)}");
        }

        if (lensEvent.RuntimeMessage is not null)
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
        LensConversationState state,
        LensPulseEvent lensEvent,
        string transcriptKind,
        string canonicalItemId)
    {
        return transcriptKind switch
        {
            "assistant" => ResolveAssistantTranscriptEntryIdForItem(state, lensEvent, canonicalItemId),
            "user" when !string.IsNullOrWhiteSpace(lensEvent.TurnId) => $"user:{lensEvent.TurnId}",
            "user" => $"user:{canonicalItemId}",
            "tool" => $"tool:{canonicalItemId}",
            _ => $"{transcriptKind}:{canonicalItemId}"
        };
    }

    private static string ResolveAssistantTranscriptEntryIdForItem(
        LensConversationState state,
        LensPulseEvent lensEvent,
        string canonicalItemId)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.TurnId))
        {
            var streamedEntryId = $"assistant-stream:{lensEvent.TurnId}";
            if (state.TranscriptEntries.ContainsKey(streamedEntryId))
            {
                return streamedEntryId;
            }
        }

        return $"assistant:{canonicalItemId}";
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
            "tool" => ResolveToolTranscriptEntryIdForStream(state.Items, lensEvent, turnId, streamKind),
            "reasoning" => $"reasoning:{streamKind}:{turnId ?? lensEvent.ItemId ?? lensEvent.EventId}",
            _ => $"{transcriptKind}:{turnId ?? lensEvent.ItemId ?? lensEvent.EventId}"
        };
    }

    private static string ResolveToolTranscriptEntryIdForStream(
        IReadOnlyDictionary<string, LensPulseItemSummary> items,
        LensPulseEvent lensEvent,
        string? turnId,
        string streamKind)
    {
        if (!string.IsNullOrWhiteSpace(lensEvent.ItemId))
        {
            return $"tool:{lensEvent.ItemId}";
        }

        var ownerItemId = ResolveOwningToolItemIdForStream(items, turnId, streamKind);
        return !string.IsNullOrWhiteSpace(ownerItemId)
            ? $"tool:{ownerItemId}"
            : $"tool:{streamKind}:{turnId ?? lensEvent.EventId}";
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

        if (normalized.Contains("reasoning", StringComparison.Ordinal) ||
            normalized.Contains("task", StringComparison.Ordinal))
        {
            return "reasoning";
        }

        if (normalized.Contains("plan", StringComparison.Ordinal))
        {
            return "plan";
        }

        return "tool";
    }

    private static string RuntimeTranscriptKindFromEventType(string? eventType)
    {
        return eventType switch
        {
            "runtime.error" => "notice",
            "runtime.warning" => "system",
            "config.warning" => "notice",
            "deprecation.notice" => "notice",
            _ => "system"
        };
    }

    private static string RuntimeTranscriptStatusFromEventType(string? eventType)
    {
        return eventType switch
        {
            "runtime.error" => "runtime.error",
            "runtime.warning" => "runtime.warning",
            "config.warning" => "warning",
            "deprecation.notice" => "warning",
            "mcp.oauth.completed" => "completed",
            _ => "info"
        };
    }

    private static string RuntimeTranscriptTitleFromEventType(string? eventType)
    {
        return eventType switch
        {
            "runtime.error" => "Error",
            "runtime.warning" => "Runtime",
            "thread.metadata.updated" => "Thread updated",
            "thread.token-usage.updated" => "Context window",
            "model.rerouted" => "Model rerouted",
            "config.warning" => "Configuration warning",
            "deprecation.notice" => "Deprecation notice",
            "account.updated" => "Account updated",
            "account.rate-limits.updated" => "Rate limits updated",
            "mcp.oauth.completed" => "MCP sign-in",
            "thread.realtime.started" => "Realtime started",
            "thread.realtime.item-added" => "Realtime item",
            "thread.realtime.audio.delta" => "Realtime audio",
            "thread.realtime.error" => "Realtime error",
            "thread.realtime.closed" => "Realtime closed",
            "auth.status" => "Authentication",
            "session.exited" => "Session exited",
            _ => "System"
        };
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

    private static string? ResolveOwningToolItemIdForStream(
        IReadOnlyDictionary<string, LensPulseItemSummary> items,
        string? turnId,
        string? streamKind)
    {
        var normalizedStreamKind = NormalizeItemType(streamKind);
        if (string.IsNullOrWhiteSpace(normalizedStreamKind))
        {
            return null;
        }

        string[] preferredItemTypes = normalizedStreamKind switch
        {
            "command_output" => ["command_execution", "command_output"],
            "file_change_output" => ["file_change", "file_change_output"],
            _ => [normalizedStreamKind]
        };

        return items.Values
            .Where(item =>
                preferredItemTypes.Contains(NormalizeItemType(item.ItemType), StringComparer.Ordinal) &&
                (string.IsNullOrWhiteSpace(turnId) ||
                 string.Equals(item.TurnId, turnId, StringComparison.Ordinal)))
            .OrderByDescending(item => item.UpdatedAt)
            .Select(item => item.ItemId)
            .FirstOrDefault();
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

    private static string MergeAssistantItemDetail(
        string? existing,
        string? incoming,
        string? status)
    {
        var normalizedIncoming = NormalizeTranscriptText(incoming).Trim();
        if (IsTerminalStatus(status) && !string.IsNullOrWhiteSpace(normalizedIncoming))
        {
            return normalizedIncoming;
        }

        return MergeProgressiveMessage(existing, incoming);
    }

    private static string AppendAssistantDelta(string? existing, string? delta)
    {
        return AppendRetainedStreamText(existing, delta, MaxAssistantStreamChars, retainHead: false, separateWithNewline: false);
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

    private static string AppendRetainedToolOutput(string? existing, string? incoming, bool retainHead)
    {
        return AppendRetainedStreamText(existing, incoming, MaxToolRawOutputChars, retainHead, separateWithNewline: true);
    }

    private static string AppendRetainedTranscriptChunk(string? existing, string? incoming, int maxChars, bool retainHead)
    {
        return AppendRetainedStreamText(existing, incoming, maxChars, retainHead, separateWithNewline: true);
    }

    private static string AppendRetainedStreamText(
        string? existing,
        string? incoming,
        int maxChars,
        bool retainHead,
        bool separateWithNewline)
    {
        var normalizedIncoming = NormalizeTranscriptText(incoming);
        if (string.IsNullOrWhiteSpace(normalizedIncoming))
        {
            return NormalizeTranscriptText(existing);
        }

        var normalizedExisting = StripRetentionMarkers(NormalizeTranscriptText(existing));
        if (string.IsNullOrWhiteSpace(normalizedExisting))
        {
            return RetainWithinBudget(normalizedIncoming, maxChars, retainHead);
        }

        var separator = separateWithNewline &&
                        !normalizedExisting.EndsWith('\n') &&
                        !normalizedIncoming.StartsWith('\n')
            ? "\n"
            : string.Empty;
        return RetainWithinBudget(normalizedExisting + separator + normalizedIncoming, maxChars, retainHead);
    }

    private static string RetainWithinBudget(string? value, int maxChars, bool retainHead)
    {
        var normalized = NormalizeTranscriptText(value);
        if (normalized.Length <= maxChars)
        {
            return normalized;
        }

        var marker = retainHead ? HeadRetentionMarker : TailRetentionMarker;
        var availableChars = maxChars - marker.Length - 1;
        if (availableChars <= 0)
        {
            return normalized[..Math.Max(0, maxChars)];
        }

        return retainHead
            ? string.Concat(normalized.AsSpan(0, availableChars), "\n", marker)
            : string.Concat(marker, "\n", normalized.AsSpan(normalized.Length - availableChars));
    }

    private static string StripRetentionMarkers(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        if (value.StartsWith(TailRetentionMarker + "\n", StringComparison.Ordinal))
        {
            return value[(TailRetentionMarker.Length + 1)..];
        }

        if (value.EndsWith("\n" + HeadRetentionMarker, StringComparison.Ordinal))
        {
            return value[..^(HeadRetentionMarker.Length + 1)];
        }

        return value;
    }

    private static string CompactHistoryLine(string line)
    {
        if (line.Length <= MaxHistoryLineChars)
        {
            return line;
        }

        var availableChars = MaxHistoryLineChars - HeadRetentionMarker.Length - 1;
        if (availableChars <= 0)
        {
            return line[..MaxHistoryLineChars];
        }

        return string.Concat(line.AsSpan(0, availableChars), " ", HeadRetentionMarker);
    }

    private static string CompactHistoryBody(string body, bool retainHead)
    {
        return RetainWithinBudget(body, MaxHistoryBodyChars, retainHead);
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

    private static void PromoteUserTranscriptEntryToTurnLead(
        LensConversationState state,
        LensPulseTranscriptEntry entry)
    {
        if (!string.Equals(entry.Kind, "user", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(entry.TurnId))
        {
            return;
        }

        var turnLeadOrder = long.MaxValue;
        foreach (var candidate in state.TranscriptEntries.Values)
        {
            if (ReferenceEquals(candidate, entry) ||
                !string.Equals(candidate.TurnId, entry.TurnId, StringComparison.Ordinal))
            {
                continue;
            }

            turnLeadOrder = Math.Min(turnLeadOrder, candidate.Order);
        }

        if (turnLeadOrder == long.MaxValue || entry.Order <= turnLeadOrder)
        {
            return;
        }

        foreach (var candidate in state.TranscriptEntries.Values)
        {
            if (ReferenceEquals(candidate, entry))
            {
                continue;
            }

            if (candidate.Order >= turnLeadOrder && candidate.Order < entry.Order)
            {
                candidate.Order += 1;
            }
        }

        entry.Order = turnLeadOrder;
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
        var diffScreenBody = kind == "diff"
            ? BuildScreenLogDiffBody(entry.Body)
            : entry.Body;
        var collapsedByDefault = kind == "diff"
            ? false
            : ShouldCollapseHistoryBodyByDefault(entry, kind);

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
            Body = diffScreenBody,
            RenderMode = ResolveHistoryRenderMode(kind, entry.Streaming),
            CollapsedByDefault = collapsedByDefault,
            Preview = kind == "diff" ? BuildHistoryPreview(diffScreenBody) : BuildHistoryPreview(entry.Body),
            LineCount = kind == "diff" ? CountHistoryBodyLines(diffScreenBody) : CountHistoryBodyLines(entry.Body),
            Streaming = entry.Streaming,
            UpdatedAt = entry.UpdatedAt,
            Attachments = CloneAttachments(entry.Attachments)
        };
    }

    private static bool ShouldIncludeInScreenHistoryLog(LensPulseTranscriptEntry entry)
    {
        return !string.IsNullOrWhiteSpace(entry.Body) ||
               (entry.Attachments?.Count ?? 0) > 0 ||
               entry.Kind is "request" or "system" or "notice";
    }

    private static string BuildScreenLogSignature(LensScreenLogDeltaRecord record)
    {
        var hash = new HashCode();
        hash.Add(record.Session.State, StringComparer.Ordinal);
        hash.Add(record.Session.StateLabel, StringComparer.Ordinal);
        hash.Add(record.Session.Reason ?? string.Empty, StringComparer.Ordinal);
        hash.Add(record.Session.LastError ?? string.Empty, StringComparer.Ordinal);
        hash.Add(record.CurrentTurn.TurnId ?? string.Empty, StringComparer.Ordinal);
        hash.Add(record.CurrentTurn.State, StringComparer.Ordinal);
        hash.Add(record.CurrentTurn.StateLabel, StringComparer.Ordinal);
        hash.Add(record.CurrentTurn.Model ?? string.Empty, StringComparer.Ordinal);
        hash.Add(record.CurrentTurn.Effort ?? string.Empty, StringComparer.Ordinal);

        foreach (var entry in record.HistoryUpserts)
        {
            hash.Add(entry.EntryId, StringComparer.Ordinal);
            hash.Add(entry.Kind, StringComparer.Ordinal);
            hash.Add(entry.ItemType ?? string.Empty, StringComparer.Ordinal);
            hash.Add(entry.Status, StringComparer.Ordinal);
            hash.Add(entry.Title, StringComparer.Ordinal);
            hash.Add(entry.Meta, StringComparer.Ordinal);
            hash.Add(entry.Body, StringComparer.Ordinal);
            hash.Add(entry.RenderMode, StringComparer.Ordinal);
            hash.Add(entry.CollapsedByDefault);
            hash.Add(entry.Streaming);
        }

        foreach (var removal in record.HistoryRemovals)
        {
            hash.Add(removal, StringComparer.Ordinal);
        }

        return hash.ToHashCode().ToString("X8");
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

        if (kind == "diff")
        {
            return "diff";
        }

        return kind is "tool" or "reasoning" or "plan" ? "monospace" : "plain";
    }

    private static bool ShouldCollapseHistoryBodyByDefault(LensPulseTranscriptEntry entry, string kind)
    {
        if (entry.Streaming || kind is not ("tool" or "reasoning" or "plan"))
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

    private static string BuildScreenLogDiffBody(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return string.Empty;
        }

        var normalized = NormalizeTranscriptText(body);
        var renderedLines = BuildScreenLogDiffLines(normalized);
        if (renderedLines.Count == 0)
        {
            return normalized.Trim();
        }

        if (renderedLines.Count > MaxVisibleDiffScreenLogLines)
        {
            var omittedCount = renderedLines.Count - MaxVisibleDiffScreenLogLines;
            renderedLines = renderedLines.Take(MaxVisibleDiffScreenLogLines)
                .Append(string.Create(CultureInfo.InvariantCulture, $"... {omittedCount} more diff lines omitted ..."))
                .ToList();
        }

        return string.Join('\n', renderedLines);
    }

    private static List<string> BuildScreenLogDiffLines(string normalizedBody)
    {
        var sourceLines = normalizedBody.Split('\n');
        var rendered = new List<string>();
        string oldPath = string.Empty;
        string newPath = string.Empty;
        var currentBody = new List<string>();
        var sawHunk = false;

        void FlushSection()
        {
            if (currentBody.Count == 0)
            {
                oldPath = string.Empty;
                newPath = string.Empty;
                sawHunk = false;
                return;
            }

            var header = FormatDiffSectionHeader(oldPath, newPath);
            if (!string.IsNullOrWhiteSpace(header))
            {
                rendered.Add(header);
            }

            rendered.AddRange(currentBody);
            currentBody.Clear();
            oldPath = string.Empty;
            newPath = string.Empty;
            sawHunk = false;
        }

        foreach (var line in sourceLines)
        {
            if (line.StartsWith("diff --git ", StringComparison.Ordinal))
            {
                FlushSection();
                oldPath = ExtractDiffGitPath(line, "a/");
                newPath = ExtractDiffGitPath(line, "b/");
                continue;
            }

            if (line.StartsWith("--- ", StringComparison.Ordinal))
            {
                oldPath = NormalizeDiffPath(line[4..]);
                continue;
            }

            if (line.StartsWith("+++ ", StringComparison.Ordinal))
            {
                newPath = NormalizeDiffPath(line[4..]);
                continue;
            }

            if (line.StartsWith("index ", StringComparison.Ordinal) ||
                line.StartsWith("new file mode ", StringComparison.Ordinal) ||
                line.StartsWith("deleted file mode ", StringComparison.Ordinal) ||
                line.StartsWith("old mode ", StringComparison.Ordinal) ||
                line.StartsWith("new mode ", StringComparison.Ordinal) ||
                line.StartsWith("similarity index ", StringComparison.Ordinal) ||
                line.StartsWith("rename from ", StringComparison.Ordinal) ||
                line.StartsWith("rename to ", StringComparison.Ordinal) ||
                line.StartsWith("copy from ", StringComparison.Ordinal) ||
                line.StartsWith("copy to ", StringComparison.Ordinal))
            {
                continue;
            }

            if (line.StartsWith("@@", StringComparison.Ordinal))
            {
                sawHunk = true;
                currentBody.Add(line);
                continue;
            }

            if (line.StartsWith("Binary files ", StringComparison.Ordinal) ||
                line.StartsWith("GIT binary patch", StringComparison.Ordinal) ||
                line.StartsWith("literal ", StringComparison.Ordinal) ||
                line.StartsWith("delta ", StringComparison.Ordinal))
            {
                currentBody.Add(line);
                continue;
            }

            if (!sawHunk && currentBody.Count == 0)
            {
                continue;
            }

            currentBody.Add(line);
        }

        FlushSection();
        if (rendered.Count > 0)
        {
            return rendered;
        }

        return sourceLines.Where(line => !string.IsNullOrWhiteSpace(line)).ToList();
    }

    private static string ExtractDiffGitPath(string line, string prefix)
    {
        if (!line.StartsWith("diff --git ", StringComparison.Ordinal))
        {
            return string.Empty;
        }

        var parts = line["diff --git ".Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            return string.Empty;
        }

        return NormalizeDiffPath(string.Equals(prefix, "a/", StringComparison.Ordinal) ? parts[0] : parts[1]);
    }

    private static string NormalizeDiffPath(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim().Trim('"', '\'');
        if (string.IsNullOrWhiteSpace(trimmed) || string.Equals(trimmed, "/dev/null", StringComparison.Ordinal))
        {
            return trimmed;
        }

        return trimmed.StartsWith("a/", StringComparison.Ordinal) || trimmed.StartsWith("b/", StringComparison.Ordinal)
            ? trimmed[2..]
            : trimmed;
    }

    private static string FormatDiffSectionHeader(string oldPath, string newPath)
    {
        var normalizedOld = NormalizeDiffPath(oldPath);
        var normalizedNew = NormalizeDiffPath(newPath);
        if (string.IsNullOrWhiteSpace(normalizedOld) && string.IsNullOrWhiteSpace(normalizedNew))
        {
            return string.Empty;
        }

        if (string.Equals(normalizedOld, "/dev/null", StringComparison.Ordinal))
        {
            return normalizedNew;
        }

        if (string.Equals(normalizedNew, "/dev/null", StringComparison.Ordinal))
        {
            return $"{normalizedOld} (deleted)";
        }

        if (string.IsNullOrWhiteSpace(normalizedOld) || string.Equals(normalizedOld, normalizedNew, StringComparison.Ordinal))
        {
            return normalizedNew;
        }

        if (string.IsNullOrWhiteSpace(normalizedNew))
        {
            return normalizedOld;
        }

        return $"{normalizedOld} -> {normalizedNew}";
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
        var timeText = value.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
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
        public string? LastScreenLogSignature { get; set; }
    }

    private sealed class LensConversationState
    {
        public string Provider { get; set; } = string.Empty;
        public LensPulseSessionSummary Session { get; } = new();
        public LensPulseThreadSummary Thread { get; } = new();
        public LensPulseTurnSummary CurrentTurn { get; } = new();
        public LensQuickSettingsSummary QuickSettings { get; } = new();
        public LensPulseStreamsSummary Streams { get; } = new();
        public Dictionary<string, LensPulseTranscriptEntry> TranscriptEntries { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, LensPulseItemSummary> Items { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, LensPulseRequestSummary> Requests { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, LensToolRenderState> ToolRenderStates { get; } = new(StringComparer.Ordinal);
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

    private sealed class LensToolRenderState
    {
        public string CommandText { get; set; } = string.Empty;
        public string RawOutput { get; set; } = string.Empty;
        public bool RetainHeadOutput { get; set; }
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

internal sealed class SubscriptionState
{
    private readonly Action _dispose;
    private int _disposed;

    public SubscriptionState(Action dispose)
    {
        _dispose = dispose;
    }

    public void Close()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _dispose();
        }
    }
}

public sealed class LensPulseSubscription : IDisposable
{
    private readonly SubscriptionState _state;
    private int _disposed;

    internal LensPulseSubscription(ChannelReader<LensPulseEvent> reader, SubscriptionState state)
    {
        Reader = reader;
        _state = state;
    }

    public ChannelReader<LensPulseEvent> Reader { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _state.Close();
    }
}

public sealed class LensPulseDeltaSubscription : IDisposable
{
    private readonly SubscriptionState _state;
    private int _disposed;

    internal LensPulseDeltaSubscription(ChannelReader<LensPulseDeltaResponse> reader, SubscriptionState state)
    {
        Reader = reader;
        _state = state;
    }

    public ChannelReader<LensPulseDeltaResponse> Reader { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _state.Close();
    }
}
