namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// A bounded, single-consumer queue that preserves FIFO order within each
/// session while allowing active sessions to bypass unrelated background work.
/// </summary>
internal sealed class BoundedSessionOutputQueue<T> : IDisposable
{
    private sealed class SessionItems
    {
        public SessionItems(LinkedListNode<string> node)
        {
            Node = node;
        }

        public LinkedList<T> Items { get; } = new();
        public LinkedListNode<string> Node { get; }
    }

    private readonly object _gate = new();
    private readonly int _capacity;
    private readonly int _activeBurstLimit;
    private readonly long _byteCapacity;
    private readonly Func<T, int>? _measureBytes;
    private readonly Dictionary<string, SessionItems> _sessions = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _roundRobinSessions = new();
    private readonly SemaphoreSlim _availableItems = new(0);
    private int _count;
    private long _queuedBytes;
    private int _consecutiveActiveDequeues;
    private bool _completed;
    private bool _disposed;

    public BoundedSessionOutputQueue(
        int capacity,
        int activeBurstLimit,
        long byteCapacity = long.MaxValue,
        Func<T, int>? measureBytes = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(capacity);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(activeBurstLimit);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(byteCapacity);
        if (byteCapacity != long.MaxValue)
        {
            ArgumentNullException.ThrowIfNull(measureBytes);
        }

        _capacity = capacity;
        _activeBurstLimit = activeBurstLimit;
        _byteCapacity = byteCapacity;
        _measureBytes = measureBytes;
    }

    internal long QueuedBytes
    {
        get
        {
            lock (_gate)
            {
                return _queuedBytes;
            }
        }
    }

    internal int Count
    {
        get
        {
            lock (_gate)
            {
                return _count;
            }
        }
    }

    public bool TryEnqueue(string sessionId, T item)
    {
        return TryEnqueueOrMerge(sessionId, item, null);
    }

    public bool TryEnqueueOrMerge(
        string sessionId,
        T item,
        TryMergeQueuedItems<T>? tryMerge)
    {
        ArgumentException.ThrowIfNullOrEmpty(sessionId);

        lock (_gate)
        {
            var itemBytes = MeasureBytes(item);
            if (_disposed
                || _completed
                || itemBytes > _byteCapacity - _queuedBytes)
            {
                return false;
            }

            if (tryMerge is not null
                && _sessions.TryGetValue(sessionId, out var mergeSession)
                && mergeSession.Items.Last is { } last
                && tryMerge(last.Value, item, out var merged))
            {
                last.Value = merged;
                _queuedBytes += itemBytes;
                return true;
            }

            if (_count >= _capacity)
            {
                return false;
            }

            if (!_sessions.TryGetValue(sessionId, out var session))
            {
                var node = _roundRobinSessions.AddLast(sessionId);
                session = new SessionItems(node);
                _sessions.Add(sessionId, session);
            }

            session.Items.AddLast(item);
            _count++;
            _queuedBytes += itemBytes;

            // Release while holding the gate so completion/drain cannot race
            // between publishing the item and publishing its availability.
            _availableItems.Release();
            return true;
        }
    }

    public async ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            await _availableItems.WaitAsync(cancellationToken).ConfigureAwait(false);

            lock (_gate)
            {
                if (_count > 0)
                {
                    return true;
                }

                if (_completed || _disposed)
                {
                    return false;
                }
            }
        }
    }

    public bool TryAcquireAvailableItem()
    {
        return _availableItems.Wait(0);
    }

    public bool TryDequeue(IReadOnlySet<string> activeSessionIds, out T item)
    {
        ArgumentNullException.ThrowIfNull(activeSessionIds);

        lock (_gate)
        {
            if (_count == 0)
            {
                item = default!;
                return false;
            }

            var selected = SelectSession(activeSessionIds);
            var session = _sessions[selected.Value];
            item = session.Items.First!.Value;
            session.Items.RemoveFirst();
            _count--;
            _queuedBytes -= MeasureBytes(item);

            var isActive = activeSessionIds.Contains(selected.Value);
            _consecutiveActiveDequeues = isActive
                ? Math.Min(_activeBurstLimit, _consecutiveActiveDequeues + 1)
                : 0;

            if (session.Items.Count == 0)
            {
                _roundRobinSessions.Remove(selected);
                _sessions.Remove(selected.Value);
            }
            else
            {
                _roundRobinSessions.Remove(selected);
                _roundRobinSessions.AddLast(selected);
            }

            return true;
        }
    }

    public void Complete()
    {
        lock (_gate)
        {
            if (_completed)
            {
                return;
            }

            _completed = true;

            // One extra permit wakes an empty consumer. If items remain, the
            // permit is observed after the final item and reports completion.
            _availableItems.Release();
        }
    }

    public List<T> Drain()
    {
        lock (_gate)
        {
            var drained = new List<T>(_count);
            foreach (var session in _sessions.Values)
            {
                while (session.Items.First is { } first)
                {
                    drained.Add(first.Value);
                    session.Items.RemoveFirst();
                }
            }

            _sessions.Clear();
            _roundRobinSessions.Clear();
            _count = 0;
            _queuedBytes = 0;
            _consecutiveActiveDequeues = 0;
            return drained;
        }
    }

    public List<T> RemoveSession(string sessionId)
    {
        ArgumentException.ThrowIfNullOrEmpty(sessionId);

        List<T> removed;
        lock (_gate)
        {
            if (!_sessions.Remove(sessionId, out var session))
            {
                return [];
            }

            _roundRobinSessions.Remove(session.Node);
            removed = new List<T>(session.Items.Count);
            while (session.Items.First is { } first)
            {
                removed.Add(first.Value);
                _queuedBytes -= MeasureBytes(first.Value);
                session.Items.RemoveFirst();
            }

            _count -= removed.Count;
            _consecutiveActiveDequeues = 0;
            // A consumer may already own one availability permit. Any permit
            // still present belongs to an item removed above. Keep the queue
            // gate while consuming it so a concurrent enqueue cannot publish
            // a new permit that is mistaken for a removed item.
            for (var i = 0; i < removed.Count; i++)
            {
                if (!_availableItems.Wait(0))
                {
                    break;
                }
            }
        }

        return removed;
    }

    private int MeasureBytes(T item)
    {
        return _measureBytes is null ? 0 : Math.Max(0, _measureBytes(item));
    }

    private LinkedListNode<string> SelectSession(IReadOnlySet<string> activeSessionIds)
    {
        var preferActive = _consecutiveActiveDequeues < _activeBurstLimit;
        var selected = FindSession(activeSessionIds, preferActive);
        if (selected is not null)
        {
            return selected;
        }

        // Either there is no active work, or no background work is available
        // for the fairness turn. In both cases, keep the queue moving.
        return _roundRobinSessions.First!;
    }

    private LinkedListNode<string>? FindSession(IReadOnlySet<string> activeSessionIds, bool active)
    {
        var node = _roundRobinSessions.First;
        while (node is not null)
        {
            if (activeSessionIds.Contains(node.Value) == active)
            {
                return node;
            }

            node = node.Next;
        }

        return null;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _completed = true;
        }

        _availableItems.Dispose();
    }
}

internal delegate bool TryMergeQueuedItems<T>(T existing, T incoming, out T merged);
