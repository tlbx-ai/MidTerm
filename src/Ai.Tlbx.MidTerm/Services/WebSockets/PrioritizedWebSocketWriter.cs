using System.Buffers;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.WebSockets;

namespace Ai.Tlbx.MidTerm.Services.WebSockets;

internal enum MuxWritePriority
{
    Control = 0,
    ActiveLive = 1,
    VisibleLive = 2,
    Recovery = 3,
    BackgroundLive = 4
}

/// <summary>
/// Owns all writes for one mux socket. The bounded priority queue prevents slow
/// clients from creating unbounded send tasks while allowing interactive and
/// control traffic to overtake replay/background chunks between frames.
/// </summary>
internal sealed class PrioritizedWebSocketWriter : IAsyncDisposable
{
    internal const int MaxQueuedFrames = 2048;
    internal const int MaxQueuedBytes = 8 * 1024 * 1024;
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(5);

    private sealed class PendingWrite
    {
        private byte[]? _ownedBuffer;
        private readonly Action<bool>? _completed;

        public PendingWrite(ReadOnlyMemory<byte> data, byte[]? ownedBuffer = null, Action<bool>? completed = null)
        {
            Data = data;
            _ownedBuffer = ownedBuffer;
            _completed = completed;
        }

        public ReadOnlyMemory<byte> Data { get; }
        public TaskCompletionSource<bool> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void Complete(bool succeeded)
        {
            Completion.TrySetResult(succeeded);
            try
            {
                _completed?.Invoke(succeeded);
            }
            catch
            {
                // Completion telemetry must never stop the socket writer.
            }
            finally
            {
                var ownedBuffer = Interlocked.Exchange(ref _ownedBuffer, null);
                if (ownedBuffer is not null)
                {
                    ArrayPool<byte>.Shared.Return(ownedBuffer);
                }
            }
        }
    }

    private readonly WebSocket _webSocket;
    private readonly Action<TimeSpan, int> _sendObserved;
    private readonly object _gate = new();
    private readonly PriorityQueue<PendingWrite, (int Priority, long Order)> _queue = new();
    private readonly SemaphoreSlim _available = new(0);
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _processor;
    private CancellationTokenSource? _sendTimeoutCts;
    private long _nextOrder;
    private long _queuedBytes;
    private bool _disposed;

    public PrioritizedWebSocketWriter(WebSocket webSocket, Action<TimeSpan, int> sendObserved)
    {
        _webSocket = webSocket;
        _sendObserved = sendObserved;
        _processor = ProcessAsync();
    }

    public ValueTask<bool> SendAsync(ReadOnlyMemory<byte> data, MuxWritePriority priority)
    {
        lock (_gate)
        {
            if (_disposed
                || _cts.IsCancellationRequested
                || _webSocket.State != WebSocketState.Open
                || _queue.Count >= MaxQueuedFrames
                || _queuedBytes + data.Length > MaxQueuedBytes)
            {
                return ValueTask.FromResult(false);
            }

            var pending = new PendingWrite(data);
            _queue.Enqueue(pending, ((int)priority, _nextOrder++));
            _queuedBytes += data.Length;
            // Dispose takes the same gate before marking the writer closed, so
            // the semaphore cannot be disposed between enqueue and release.
            _available.Release();
            return new ValueTask<bool>(pending.Completion.Task);
        }
    }

    public bool TryQueueCopy(ReadOnlySpan<byte> data, MuxWritePriority priority, Action<bool>? completed = null)
    {
        lock (_gate)
        {
            if (_disposed
                || _cts.IsCancellationRequested
                || _webSocket.State != WebSocketState.Open
                || _queue.Count >= MaxQueuedFrames
                || _queuedBytes + data.Length > MaxQueuedBytes)
            {
                return false;
            }

            var ownedBuffer = ArrayPool<byte>.Shared.Rent(data.Length);
            data.CopyTo(ownedBuffer);
            var pending = new PendingWrite(ownedBuffer.AsMemory(0, data.Length), ownedBuffer, completed);
            _queue.Enqueue(pending, ((int)priority, _nextOrder++));
            _queuedBytes += data.Length;
            _available.Release();
            return true;
        }
    }

    private async Task ProcessAsync()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                await _available.WaitAsync(_cts.Token).ConfigureAwait(false);
                PendingWrite? pending;
                lock (_gate)
                {
                    _queue.TryDequeue(out pending, out _);
                    if (pending is not null)
                    {
                        _queuedBytes -= pending.Data.Length;
                    }
                }

                if (pending is null)
                {
                    continue;
                }

                if (!await SendCoreAsync(pending.Data).ConfigureAwait(false))
                {
                    pending.Complete(false);
                    FailPendingWrites();
                    return;
                }

                pending.Complete(true);
            }
        }
        catch (OperationCanceledException) when (_cts.IsCancellationRequested)
        {
        }
        finally
        {
            FailPendingWrites();
        }
    }

    private async Task<bool> SendCoreAsync(ReadOnlyMemory<byte> data)
    {
        if (_webSocket.State != WebSocketState.Open)
        {
            return false;
        }

        if (_sendTimeoutCts is null || !_sendTimeoutCts.TryReset())
        {
            _sendTimeoutCts?.Dispose();
            _sendTimeoutCts = new CancellationTokenSource();
        }
        _sendTimeoutCts.CancelAfter(SendTimeout);

        var startedAt = Stopwatch.GetTimestamp();
        try
        {
            await _webSocket.SendAsync(data, WebSocketMessageType.Binary, true, _sendTimeoutCts.Token).ConfigureAwait(false);
            _sendObserved(Stopwatch.GetElapsedTime(startedAt), data.Length);
            return true;
        }
        catch (OperationCanceledException)
        {
            AbortSocket();
            return false;
        }
        catch (WebSocketException)
        {
            AbortSocket();
            return false;
        }
        catch (ObjectDisposedException)
        {
            return false;
        }
    }

    private void FailPendingWrites()
    {
        List<PendingWrite> failed = [];
        lock (_gate)
        {
            while (_queue.TryDequeue(out var pending, out _))
            {
                failed.Add(pending);
            }
            _queuedBytes = 0;
        }

        foreach (var pending in failed)
        {
            pending.Complete(false);
        }
    }

    private void AbortSocket()
    {
        try
        {
            _webSocket.Abort();
        }
        catch
        {
        }
    }

    public async ValueTask DisposeAsync()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
        }
        _cts.Cancel();
        _sendTimeoutCts?.Cancel();
        _available.Release();

        try
        {
            await _processor.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        _sendTimeoutCts?.Dispose();
        _available.Dispose();
        _cts.Dispose();
    }
}
