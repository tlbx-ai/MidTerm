using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using System.Globalization;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class ManagerBarQueueService : IAsyncDisposable
{
    private const double CooldownHeatThreshold = 0.25;
    private const int PostTriggerIgnoreHeatMs = 5000;
    private const int PollIntervalMs = 500;
    private const int DuplicateEnqueueWindowMs = 1500;

    private readonly string _statePath;
    private readonly IManagerBarQueueRuntime _runtime;
    private readonly TimeProvider _timeProvider;
    private readonly Lock _lock = new();
    private readonly CancellationTokenSource _shutdownCts = new();
    private readonly TaskCompletionSource _startedTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private List<ManagerBarQueueEntryDto> _entries = [];
    private readonly Dictionary<string, RecentEnqueue> _recentEnqueues = new(StringComparer.Ordinal);
    private string _serializedState = string.Empty;
    private Task? _processingTask;

    private sealed record RecentEnqueue(string QueueId, DateTimeOffset EnqueuedAt);

    public ManagerBarQueueService(
        SettingsService settingsService,
        IManagerBarQueueRuntime runtime,
        TimeProvider? timeProvider = null)
        : this(settingsService.SettingsDirectory, runtime, timeProvider)
    {
    }

    public ManagerBarQueueService(
        string settingsDirectory,
        IManagerBarQueueRuntime runtime,
        TimeProvider? timeProvider = null)
    {
        _statePath = Path.Combine(settingsDirectory, "manager-bar-queue.json");
        _runtime = runtime;
        _timeProvider = timeProvider ?? TimeProvider.System;
        Load();
    }

    public event Action? OnChanged;

    public void Start()
    {
        lock (_lock)
        {
            if (_processingTask is not null)
            {
                return;
            }

            _processingTask = Task.Run(ProcessLoopAsync);
            _startedTcs.TrySetResult();
        }
    }

    public IReadOnlyList<ManagerBarQueueEntryDto> GetSnapshot(IEnumerable<string>? validSessionIds = null)
    {
        List<ManagerBarQueueEntryDto> snapshot;
        lock (_lock)
        {
            snapshot = CloneEntries(_entries);
        }

        return FilterToValidSessions(snapshot, validSessionIds);
    }

    public ManagerBarQueueEntryDto? Enqueue(string sessionId, ManagerBarButton action)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var normalizedAction = action.Normalize();
        if (IsImmediateManagerAction(normalizedAction))
        {
            return null;
        }

        var trimmedSessionId = sessionId.Trim();
        var now = _timeProvider.GetUtcNow();
        var phase = GetInitialQueuePhase(normalizedAction);
        var nextRunAt = phase == QueuePhase.PendingSchedule
            ? ComputeNextScheduleTime(normalizedAction.Trigger.Schedule, now)
            : null;
        if (phase == QueuePhase.PendingSchedule && nextRunAt is null)
        {
            return null;
        }

        ManagerBarQueueEntryDto entry;
        lock (_lock)
        {
            PruneRecentEnqueuesLocked(now);
            var enqueueSignature = BuildEnqueueSignature(trimmedSessionId, normalizedAction);
            if (TryGetRecentDuplicateLocked(enqueueSignature, now, out var existing))
            {
                return existing;
            }

            entry = new ManagerBarQueueEntryDto
            {
                QueueId = $"{normalizedAction.Id}-{Guid.NewGuid():N}",
                SessionId = trimmedSessionId,
                Action = normalizedAction,
                Phase = phase,
                NextPromptIndex = 0,
                CompletedCycles = 0,
                NextRunAt = nextRunAt,
                IgnoreHeatUntil = null,
                AwaitingHeatRise = false
            };

            _entries.Add(CloneEntry(entry));
            _recentEnqueues[enqueueSignature] = new RecentEnqueue(entry.QueueId, now);
            PersistLocked();
        }

        OnChanged?.Invoke();
        return entry;
    }

    public bool Remove(string queueId)
    {
        if (string.IsNullOrWhiteSpace(queueId))
        {
            return false;
        }

        var removed = false;
        lock (_lock)
        {
            var index = _entries.FindIndex(entry => string.Equals(entry.QueueId, queueId, StringComparison.Ordinal));
            if (index >= 0)
            {
                _entries.RemoveAt(index);
                PersistLocked();
                removed = true;
            }
        }

        if (removed)
        {
            OnChanged?.Invoke();
        }

        return removed;
    }

    public void RemoveSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        var removed = false;
        lock (_lock)
        {
            for (var index = _entries.Count - 1; index >= 0; index--)
            {
                if (!string.Equals(_entries[index].SessionId, sessionId, StringComparison.Ordinal))
                {
                    continue;
                }

                _entries.RemoveAt(index);
                removed = true;
            }

            if (removed)
            {
                PersistLocked();
            }
        }

        if (removed)
        {
            OnChanged?.Invoke();
        }
    }

    public void PruneToValidSessions(IEnumerable<string>? validSessionIds)
    {
        var validSet = CreateValidSet(validSessionIds);
        if (validSet is null)
        {
            return;
        }

        var removed = false;
        lock (_lock)
        {
            for (var index = _entries.Count - 1; index >= 0; index--)
            {
                if (validSet.Contains(_entries[index].SessionId))
                {
                    continue;
                }

                _entries.RemoveAt(index);
                removed = true;
            }

            if (removed)
            {
                PersistLocked();
            }
        }

        if (removed)
        {
            OnChanged?.Invoke();
        }
    }

    private async Task ProcessLoopAsync()
    {
        var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(PollIntervalMs));
        try
        {
            while (await timer.WaitForNextTickAsync(_shutdownCts.Token).ConfigureAwait(false))
            {
                await ProcessEntriesAsync(_shutdownCts.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            timer.Dispose();
        }
    }

    private async Task ProcessEntriesAsync(CancellationToken cancellationToken)
    {
        await _startedTcs.Task.ConfigureAwait(false);

        var validSessionIds = new HashSet<string>(_runtime.GetActiveSessionIds(), StringComparer.Ordinal);
        var now = DateTimeOffset.UtcNow;
        var changed = false;
        var pendingSends = new List<(string SessionId, string Prompt)>();

        lock (_lock)
        {
            for (var index = _entries.Count - 1; index >= 0; index--)
            {
                var entry = _entries[index];
                if (!validSessionIds.Contains(entry.SessionId))
                {
                    _entries.RemoveAt(index);
                    changed = true;
                    continue;
                }

                if (!IsQueueEntryReady(entry, now))
                {
                    continue;
                }

                var prompt = entry.Action.Prompts.ElementAtOrDefault(entry.NextPromptIndex);
                if (string.IsNullOrWhiteSpace(prompt))
                {
                    _entries.RemoveAt(index);
                    changed = true;
                    continue;
                }

                pendingSends.Add((entry.SessionId, prompt));
                AdvanceQueueEntry(entry, index, now);
                changed = true;
            }

            if (changed)
            {
                PersistLocked();
            }
        }

        if (changed)
        {
            OnChanged?.Invoke();
        }

        foreach (var send in pendingSends)
        {
            try
            {
                await _runtime.SendPromptAsync(send.SessionId, send.Prompt, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Manager bar queue send failed for session {send.SessionId}: {ex.Message}");
            }
        }
    }

    private bool IsQueueEntryReady(ManagerBarQueueEntryDto entry, DateTimeOffset now)
    {
        var phase = ParsePhase(entry.Phase);
        if (phase == QueuePhase.PendingImmediate)
        {
            return true;
        }

        if (phase is QueuePhase.PendingCooldown or QueuePhase.ChainCooldown)
        {
            var heat = _runtime.GetCurrentHeat(entry.SessionId);
            return EvaluateCooldown(entry, heat, now);
        }

        return entry.NextRunAt is not null && now >= entry.NextRunAt.Value;
    }

    private static bool EvaluateCooldown(
        ManagerBarQueueEntryDto entry,
        double currentHeat,
        DateTimeOffset now)
    {
        if (entry.IgnoreHeatUntil is not null && now < entry.IgnoreHeatUntil.Value)
        {
            return false;
        }

        if (entry.AwaitingHeatRise && currentHeat > CooldownHeatThreshold)
        {
            entry.AwaitingHeatRise = false;
        }

        if (currentHeat > CooldownHeatThreshold)
        {
            return false;
        }

        return !entry.AwaitingHeatRise;
    }

    private void AdvanceQueueEntry(ManagerBarQueueEntryDto entry, int index, DateTimeOffset now)
    {
        entry.NextPromptIndex += 1;
        if (entry.NextPromptIndex < entry.Action.Prompts.Count)
        {
            entry.Phase = QueuePhase.ChainCooldown;
            entry.IgnoreHeatUntil = now.AddMilliseconds(PostTriggerIgnoreHeatMs);
            entry.AwaitingHeatRise = true;
            entry.NextRunAt = null;
            return;
        }

        entry.CompletedCycles += 1;
        entry.NextPromptIndex = 0;

        var trigger = entry.Action.Trigger.Normalize();
        switch (trigger.Kind)
        {
            case "fireAndForget":
            case "onCooldown":
                _entries.RemoveAt(index);
                return;
            case "repeatCount":
                if (entry.CompletedCycles >= trigger.RepeatCount)
                {
                    _entries.RemoveAt(index);
                    return;
                }

                entry.Phase = QueuePhase.PendingCooldown;
                entry.IgnoreHeatUntil = now.AddMilliseconds(PostTriggerIgnoreHeatMs);
                entry.AwaitingHeatRise = true;
                entry.NextRunAt = null;
                return;
            case "repeatInterval":
                entry.Phase = QueuePhase.PendingInterval;
                entry.NextRunAt = now.Add(IntervalToTimeSpan(trigger));
                entry.IgnoreHeatUntil = null;
                entry.AwaitingHeatRise = false;
                return;
            case "schedule":
                entry.Phase = QueuePhase.PendingSchedule;
                entry.NextRunAt = ComputeNextScheduleTime(trigger.Schedule, now);
                entry.IgnoreHeatUntil = null;
                entry.AwaitingHeatRise = false;
                if (entry.NextRunAt is null)
                {
                    _entries.RemoveAt(index);
                }
                return;
            default:
                _entries.RemoveAt(index);
                return;
        }
    }

    private void Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_statePath))
            {
                _entries = [];
                _serializedState = SerializeEntries(_entries);
                return;
            }

            try
            {
                var json = File.ReadAllText(_statePath);
                var stored = JsonSerializer.Deserialize(
                                 json,
                                 AppJsonContext.Default.ListManagerBarQueueEntryDto)
                             ?? [];
                _entries = stored
                    .Select(NormalizeEntry)
                    .Where(static entry => entry is not null)
                    .Cast<ManagerBarQueueEntryDto>()
                    .ToList();
                _serializedState = SerializeEntries(_entries);
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to load manager bar queue: {ex.Message}");
                _entries = [];
                _serializedState = SerializeEntries(_entries);
            }
        }
    }

    private void PersistLocked()
    {
        try
        {
            _serializedState = SerializeEntries(_entries);
            var dir = Path.GetDirectoryName(_statePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            if (_entries.Count == 0)
            {
                if (File.Exists(_statePath))
                {
                    File.Delete(_statePath);
                }

                return;
            }

            File.WriteAllText(_statePath, _serializedState);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Failed to save manager bar queue: {ex.Message}");
        }
    }

    private bool TryGetRecentDuplicateLocked(
        string enqueueSignature,
        DateTimeOffset now,
        out ManagerBarQueueEntryDto? entry)
    {
        entry = null;
        if (!_recentEnqueues.TryGetValue(enqueueSignature, out var recent))
        {
            return false;
        }

        if ((now - recent.EnqueuedAt).TotalMilliseconds > DuplicateEnqueueWindowMs)
        {
            _recentEnqueues.Remove(enqueueSignature);
            return false;
        }

        var existing = _entries.FirstOrDefault(candidate =>
            string.Equals(candidate.QueueId, recent.QueueId, StringComparison.Ordinal));
        if (existing is null)
        {
            _recentEnqueues.Remove(enqueueSignature);
            return false;
        }

        entry = CloneEntry(existing);
        return true;
    }

    private void PruneRecentEnqueuesLocked(DateTimeOffset now)
    {
        foreach (var pair in _recentEnqueues.ToArray())
        {
            if ((now - pair.Value.EnqueuedAt).TotalMilliseconds <= DuplicateEnqueueWindowMs)
            {
                continue;
            }

            _recentEnqueues.Remove(pair.Key);
        }
    }

    private static string BuildEnqueueSignature(string sessionId, ManagerBarButton action)
    {
        var prompts = string.Join(
            "\u001f",
            action.Prompts.Select(static prompt => prompt.Trim()));
        var schedule = string.Join(
            "\u001e",
            action.Trigger.Schedule.Select(static scheduleEntry => $"{scheduleEntry.Repeat}@{scheduleEntry.TimeOfDay}"));

        return string.Join(
            "\u001d",
            sessionId,
            action.Id,
            action.Label,
            action.ActionType,
            action.Trigger.Kind,
            action.Trigger.RepeatCount.ToString(CultureInfo.InvariantCulture),
            action.Trigger.RepeatEveryValue.ToString(CultureInfo.InvariantCulture),
            action.Trigger.RepeatEveryUnit,
            prompts,
            schedule);
    }

    private static ManagerBarQueueEntryDto? NormalizeEntry(ManagerBarQueueEntryDto? entry)
    {
        if (entry is null || string.IsNullOrWhiteSpace(entry.SessionId))
        {
            return null;
        }

        var normalizedAction = entry.Action?.Normalize();
        if (normalizedAction is null || IsImmediateManagerAction(normalizedAction))
        {
            return null;
        }

        var maxPromptIndex = Math.Max(0, normalizedAction.Prompts.Count - 1);
        var phase = ParsePhase(entry.Phase);
        return new ManagerBarQueueEntryDto
        {
            QueueId = string.IsNullOrWhiteSpace(entry.QueueId) ? Guid.NewGuid().ToString("N") : entry.QueueId,
            SessionId = entry.SessionId.Trim(),
            Action = normalizedAction,
            Phase = phase,
            NextPromptIndex = Math.Clamp(entry.NextPromptIndex, 0, maxPromptIndex),
            CompletedCycles = Math.Max(0, entry.CompletedCycles),
            NextRunAt = entry.NextRunAt,
            IgnoreHeatUntil = entry.IgnoreHeatUntil,
            AwaitingHeatRise = entry.AwaitingHeatRise
        };
    }

    private static IReadOnlyList<ManagerBarQueueEntryDto> FilterToValidSessions(
        IReadOnlyList<ManagerBarQueueEntryDto> entries,
        IEnumerable<string>? validSessionIds)
    {
        var validSet = CreateValidSet(validSessionIds);
        if (validSet is null)
        {
            return entries;
        }

        return entries
            .Where(entry => validSet.Contains(entry.SessionId))
            .Select(CloneEntry)
            .ToArray();
    }

    private static HashSet<string>? CreateValidSet(IEnumerable<string>? validSessionIds)
    {
        return validSessionIds is null
            ? null
            : new HashSet<string>(
                validSessionIds.Where(static id => !string.IsNullOrWhiteSpace(id)),
                StringComparer.Ordinal);
    }

    private static List<ManagerBarQueueEntryDto> CloneEntries(IEnumerable<ManagerBarQueueEntryDto> entries)
    {
        return entries.Select(CloneEntry).ToList();
    }

    private static ManagerBarQueueEntryDto CloneEntry(ManagerBarQueueEntryDto entry)
    {
        return new ManagerBarQueueEntryDto
        {
            QueueId = entry.QueueId,
            SessionId = entry.SessionId,
            Action = entry.Action.Normalize(),
            Phase = ParsePhase(entry.Phase),
            NextPromptIndex = entry.NextPromptIndex,
            CompletedCycles = entry.CompletedCycles,
            NextRunAt = entry.NextRunAt,
            IgnoreHeatUntil = entry.IgnoreHeatUntil,
            AwaitingHeatRise = entry.AwaitingHeatRise
        };
    }

    private static bool IsImmediateManagerAction(ManagerBarButton action)
    {
        return string.Equals(action.ActionType, "single", StringComparison.Ordinal)
               && string.Equals(action.Trigger.Kind, "fireAndForget", StringComparison.Ordinal);
    }

    private static string GetInitialQueuePhase(ManagerBarButton action)
    {
        if (string.Equals(action.Trigger.Kind, "schedule", StringComparison.Ordinal))
        {
            return QueuePhase.PendingSchedule;
        }

        if (ShouldWaitForInitialCooldown(action))
        {
            return QueuePhase.PendingCooldown;
        }

        return QueuePhase.PendingImmediate;
    }

    private static bool ShouldWaitForInitialCooldown(ManagerBarButton action)
    {
        return action.Trigger.Kind is "onCooldown" or "repeatCount" or "repeatInterval";
    }

    private static string ParsePhase(string? phase)
    {
        return phase switch
        {
            QueuePhase.PendingCooldown => QueuePhase.PendingCooldown,
            QueuePhase.ChainCooldown => QueuePhase.ChainCooldown,
            QueuePhase.PendingInterval => QueuePhase.PendingInterval,
            QueuePhase.PendingSchedule => QueuePhase.PendingSchedule,
            _ => QueuePhase.PendingImmediate
        };
    }

    private static TimeSpan IntervalToTimeSpan(ManagerBarTrigger trigger)
    {
        var value = Math.Max(1, trigger.RepeatEveryValue);
        return trigger.RepeatEveryUnit switch
        {
            "seconds" => TimeSpan.FromSeconds(value),
            "hours" => TimeSpan.FromHours(value),
            "days" => TimeSpan.FromDays(value),
            _ => TimeSpan.FromMinutes(value)
        };
    }

    private static DateTimeOffset? ComputeNextScheduleTime(
        IEnumerable<ManagerBarScheduleEntry> schedule,
        DateTimeOffset from)
    {
        DateTimeOffset? best = null;
        var baseLocal = from.LocalDateTime;

        for (var dayOffset = 0; dayOffset < 8; dayOffset += 1)
        {
            var day = baseLocal.Date.AddDays(dayOffset);
            foreach (var entry in schedule)
            {
                var normalized = entry.Normalize();
                if (normalized is null || !IsScheduleRepeatActive(normalized.Repeat, day.DayOfWeek))
                {
                    continue;
                }

                var parts = normalized.TimeOfDay.Split(':', StringSplitOptions.TrimEntries);
                if (parts.Length != 2 ||
                    !int.TryParse(parts[0], out var hours) ||
                    !int.TryParse(parts[1], out var minutes))
                {
                    continue;
                }

                var candidateLocal = day.AddHours(hours).AddMinutes(minutes);
                var candidate = new DateTimeOffset(candidateLocal, from.Offset);
                if (candidate <= from)
                {
                    continue;
                }

                if (best is null || candidate < best.Value)
                {
                    best = candidate;
                }
            }
        }

        return best;
    }

    private static bool IsScheduleRepeatActive(string repeat, DayOfWeek dayOfWeek)
    {
        return repeat switch
        {
            "weekdays" => dayOfWeek is >= DayOfWeek.Monday and <= DayOfWeek.Friday,
            "weekends" => dayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday,
            _ => true
        };
    }

    private static string SerializeEntries(IReadOnlyList<ManagerBarQueueEntryDto> entries)
    {
        return JsonSerializer.Serialize(entries, AppJsonContext.Default.ListManagerBarQueueEntryDto);
    }

    public async ValueTask DisposeAsync()
    {
        _shutdownCts.Cancel();
        if (_processingTask is not null)
        {
            try
            {
                await _processingTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        _shutdownCts.Dispose();
    }

    private static class QueuePhase
    {
        public const string PendingImmediate = "pendingImmediate";
        public const string PendingCooldown = "pendingCooldown";
        public const string ChainCooldown = "chainCooldown";
        public const string PendingInterval = "pendingInterval";
        public const string PendingSchedule = "pendingSchedule";
    }
}
