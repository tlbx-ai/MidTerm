using System.Globalization;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// Keeps non-idempotent terminal launches alive independently of an individual
/// HTTP connection and lets reconnecting clients join the original operation.
/// </summary>
public sealed class SessionLaunchCoordinator
{
    internal static readonly TimeSpan LaunchTimeout = TimeSpan.FromSeconds(8);
    internal static readonly TimeSpan CompletedRetention = TimeSpan.FromMinutes(2);
    private const int MaxRetainedEntries = 512;

    private readonly Lock _lock = new();
    private readonly Dictionary<string, LaunchEntry> _entries = new(StringComparer.Ordinal);
    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _launchTimeout;

    public SessionLaunchCoordinator()
        : this(TimeProvider.System, LaunchTimeout)
    {
    }

    internal SessionLaunchCoordinator(TimeProvider timeProvider, TimeSpan launchTimeout)
    {
        _timeProvider = timeProvider;
        _launchTimeout = launchTimeout;
    }

    internal async Task<SessionCreationResult> RunAsync(
        string launchRequestId,
        string requestFingerprint,
        Func<CancellationToken, Task<SessionCreationResult>> launch,
        CancellationToken requestCancellation)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(launchRequestId);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestFingerprint);
        ArgumentNullException.ThrowIfNull(launch);

        LaunchEntry entry;
        lock (_lock)
        {
            PruneLocked();
            if (_entries.TryGetValue(launchRequestId, out var existing))
            {
                if (!string.Equals(existing.RequestFingerprint, requestFingerprint, StringComparison.Ordinal))
                {
                    return SessionCreationResult.Failed(new SessionLaunchFailure(
                        "idempotency",
                        "This launch request ID was already used with different session settings.",
                        "Generate a new launchRequestId before starting a different session."));
                }

                entry = existing;
            }
            else
            {
                entry = new LaunchEntry(requestFingerprint);
                entry.Operation = new Lazy<Task<SessionCreationResult>>(
                    () => ExecuteLaunchAsync(launchRequestId, entry, launch),
                    LazyThreadSafetyMode.ExecutionAndPublication);
                _entries.Add(launchRequestId, entry);
            }
        }

        return await entry.Operation.Value.WaitAsync(requestCancellation).ConfigureAwait(false);
    }

    private async Task<SessionCreationResult> ExecuteLaunchAsync(
        string launchRequestId,
        LaunchEntry entry,
        Func<CancellationToken, Task<SessionCreationResult>> launch)
    {
        using var timeout = new CancellationTokenSource(_launchTimeout);
        try
        {
            return await launch(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested)
        {
            Log.Warn(() => string.Create(
                CultureInfo.InvariantCulture,
                $"Session launch {launchRequestId} exceeded the {_launchTimeout.TotalSeconds:0.#} second startup deadline."));
            return SessionCreationResult.Failed(new SessionLaunchFailure(
                "timeout",
                "The terminal host did not become ready before the startup deadline.",
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"The idempotent launch operation exceeded {_launchTimeout.TotalMilliseconds:0} ms and was cleaned up.")));
        }
        catch (Exception ex)
        {
            Log.Exception(ex, $"Session launch {launchRequestId}");
            return SessionCreationResult.Failed(new SessionLaunchFailure(
                "unexpected",
                "tlbx could not complete the terminal launch.",
                ex.Message,
                ex.GetType().Name));
        }
        finally
        {
            lock (_lock)
            {
                entry.CompletedAt = _timeProvider.GetUtcNow();
            }
        }
    }

    private void PruneLocked()
    {
        var cutoff = _timeProvider.GetUtcNow() - CompletedRetention;
        foreach (var key in _entries
                     .Where(pair => pair.Value.CompletedAt is { } completedAt && completedAt <= cutoff)
                     .Select(static pair => pair.Key)
                     .ToArray())
        {
            _entries.Remove(key);
        }

        if (_entries.Count <= MaxRetainedEntries)
        {
            return;
        }

        foreach (var key in _entries
                     .Where(static pair => pair.Value.CompletedAt is not null)
                     .OrderBy(static pair => pair.Value.CompletedAt)
                     .Take(_entries.Count - MaxRetainedEntries)
                     .Select(static pair => pair.Key)
                     .ToArray())
        {
            _entries.Remove(key);
        }
    }

    private sealed class LaunchEntry(string requestFingerprint)
    {
        public string RequestFingerprint { get; } = requestFingerprint;
        public Lazy<Task<SessionCreationResult>> Operation { get; set; } = null!;
        public DateTimeOffset? CompletedAt { get; set; }
    }
}
