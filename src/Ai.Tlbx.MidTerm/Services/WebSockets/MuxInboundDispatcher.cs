namespace Ai.Tlbx.MidTerm.Services.WebSockets;

/// <summary>
/// Bounded, connection-owned work lanes. Input and its trace markers are FIFO
/// per session; recovery has a separate lane so replay never holds up input.
/// Admission waits only on genuine overload, never drops accepted keystrokes.
/// </summary>
internal sealed class MuxInboundDispatcher : IAsyncDisposable
{
    internal const int MaxItems = 256;
    internal const int MaxBytes = 4 * 1024 * 1024;
    private sealed record Work(Func<CancellationToken, Task> Run, int Bytes, int? MergePriority);
    private sealed class Lane
    {
        public LinkedList<Work> Queue { get; } = new();
        public TaskCompletionSource Completed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private readonly object _gate = new();
    private readonly Dictionary<string, Lane> _lanes = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _cts;
    private readonly CancellationToken _token;
    private readonly Action<Exception> _failed;
    private TaskCompletionSource _capacity = NewSignal();
    private int _items;
    private int _bytes;
    private bool _stopped;
    private int _disposeStarted;
    private readonly TaskCompletionSource _disposed = NewSignal();

    public MuxInboundDispatcher(Action<Exception> failed, CancellationToken ct)
    {
        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _token = _cts.Token;
        _failed = failed;
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    public async ValueTask EnqueueAsync(string key, Func<CancellationToken, Task> run, int bytes = 0, int? mergePriority = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(bytes);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(bytes, MaxBytes);
        while (true)
        {
            Task wait;
            Lane? start = null;
            var admitted = false;
            lock (_gate)
            {
                if (_stopped) throw new OperationCanceledException();
                _token.ThrowIfCancellationRequested();
                _lanes.TryGetValue(key, out var lane);
                // Recovery requests own no receive-buffer bytes. Fold repeated
                // pending requests into one follow-up, keeping full over delta.
                if (bytes == 0 && mergePriority is int priority && lane?.Queue.Last is { } last &&
                    last.Value.MergePriority is int previousPriority)
                {
                    if (priority >= previousPriority) last.Value = new Work(run, 0, priority);
                    return;
                }
                if (_items < MaxItems && _bytes + bytes <= MaxBytes)
                {
                    if (lane is null)
                    {
                        lane = new Lane();
                        _lanes.Add(key, lane);
                        start = lane;
                    }
                    lane.Queue.AddLast(new Work(run, bytes, mergePriority));
                    _items++;
                    _bytes += bytes;
                    admitted = true;
                    wait = Task.CompletedTask;
                }
                else wait = _capacity.Task;
            }
            // Always enter the worker, including after cancellation, so it can
            // release its lane and complete the connection's shutdown barrier.
            if (start is not null) _ = Task.Run(() => ProcessAsync(key, start), CancellationToken.None);
            if (admitted) return;
            await wait.WaitAsync(_token).ConfigureAwait(false);
        }
    }

    private async Task ProcessAsync(string key, Lane lane)
    {
        try
        {
            while (true)
            {
                Work work;
                lock (_gate)
                {
                    if (_cts.IsCancellationRequested || lane.Queue.First is null) return;
                    work = lane.Queue.First.Value;
                    lane.Queue.RemoveFirst();
                }
                try { await work.Run(_token).ConfigureAwait(false); }
                finally
                {
                    lock (_gate)
                    {
                        _items--;
                        _bytes -= work.Bytes;
                        SignalCapacity();
                    }
                }
            }
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested) { }
        catch (Exception ex)
        {
            _cts.Cancel();
            try { _failed(ex); } catch { /* Failure telemetry cannot strand lanes. */ }
        }
        finally
        {
            lock (_gate)
            {
                // Removal and queue inspection are atomic with publication.
                // If a producer appended after the empty check, transfer those
                // items to a successor before publishing this lane's completion.
                if (!_cts.IsCancellationRequested && lane.Queue.Count > 0)
                {
                    _ = Task.Run(() => ProcessAsync(key, lane), CancellationToken.None);
                }
                else
                {
                    foreach (var pending in lane.Queue) { _items--; _bytes -= pending.Bytes; }
                    lane.Queue.Clear();
                    _lanes.Remove(key);
                    lane.Completed.TrySetResult();
                }
                SignalCapacity();
            }
        }
    }

    private void SignalCapacity()
    {
        var previous = _capacity;
        _capacity = NewSignal();
        previous.TrySetResult();
    }

    public async Task CompleteAsync(CancellationToken ct)
    {
        Task[] workers;
        lock (_gate)
        {
            _stopped = true;
            workers = _lanes.Values.Select(lane => lane.Completed.Task).ToArray();
        }
        // Closing the browser must not cancel keys already admitted ahead of
        // its close frame. An unavailable host is still bounded and reported.
        await Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposeStarted, 1) != 0)
        {
            await _disposed.Task.ConfigureAwait(false);
            return;
        }
        Task[] workers;
        lock (_gate)
        {
            _stopped = true;
            workers = _lanes.Values.Select(lane => lane.Completed.Task).ToArray();
        }
        try
        {
            await _cts.CancelAsync().ConfigureAwait(false);
            await Task.WhenAll(workers).ConfigureAwait(false);
        }
        finally
        {
            _cts.Dispose();
            _disposed.TrySetResult();
        }
    }
}
