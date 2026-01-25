using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Reference-counted pooled buffer shared across mux clients to avoid per-client copies.
/// </summary>
internal sealed class SharedOutputBuffer
{
    private byte[] _buffer;
    private int _length;
    private int _refCount;

    private SharedOutputBuffer(byte[] buffer, int length)
    {
        _buffer = buffer;
        _length = length;
        _refCount = 1;
    }

    public int Length => _length;
    public ReadOnlySpan<byte> Span => _buffer.AsSpan(0, _length);
    public Memory<byte> Memory => _buffer.AsMemory(0, _length);
    public Span<byte> WriteSpan => _buffer.AsSpan(0, _length);

    public static SharedOutputBuffer Rent(int length)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(length);
        return new SharedOutputBuffer(buffer, length);
    }

    public void AddRef()
    {
        Interlocked.Increment(ref _refCount);
    }

    public void Release()
    {
        if (Interlocked.Decrement(ref _refCount) == 0)
        {
            var buffer = _buffer;
            _buffer = Array.Empty<byte>();
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}

/// <summary>
/// WebSocket client with per-session output buffering.
/// Active session gets immediate delivery; background sessions batch for efficiency.
/// Uses ArrayPool for zero-allocation buffering.
/// </summary>
public sealed class MuxClient : IAsyncDisposable
{
    private const int FlushThresholdBytes = MuxProtocol.CompressionThreshold;
    private const int MaxBufferBytesPerSession = 256 * 1024; // 256KB per session
    private const int MaxQueuedItems = 1000;
    private static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan LoopCheckInterval = TimeSpan.FromMilliseconds(1000);

    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Channel<OutputItem> _inputChannel;
    private readonly Dictionary<string, SessionBuffer> _sessionBuffers = new();
    private readonly ConcurrentQueue<string> _sessionsToRemove = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _processor;

    private CancellationTokenSource? _loopTimeoutCts;
    private CancellationTokenRegistration _loopCtReg;
    private static readonly Action<object?> s_cancelCallback = static state =>
        ((CancellationTokenSource?)state)?.Cancel();

    private volatile string? _activeSessionId;
    private int _droppedFrameCount;

    public string Id { get; }
    public WebSocket WebSocket { get; }

    private readonly record struct OutputItem(string SessionId, int Cols, int Rows, SharedOutputBuffer Buffer);

    /// <summary>
    /// Pooled contiguous buffer for session output. Uses ArrayPool to avoid GC pressure.
    /// </summary>
    private sealed class SessionBuffer : IDisposable
    {
        private byte[] _buffer;
        private int _position;
        private bool _disposed;

        public int TotalBytes => _position;
        public int LastCols { get; set; }
        public int LastRows { get; set; }
        public long LastFlushTicks { get; set; } = Environment.TickCount64;
        public int DroppedBytes { get; set; }

        public SessionBuffer()
        {
            _buffer = ArrayPool<byte>.Shared.Rent(MaxBufferBytesPerSession);
        }

        public void Write(ReadOnlySpan<byte> data)
        {
            if (_disposed) return;

            // If this write would exceed capacity, drop oldest data by shifting
            if (_position + data.Length > _buffer.Length)
            {
                var overflow = _position + data.Length - _buffer.Length;

                if (overflow >= _position)
                {
                    // Need to drop everything - incoming data is larger than buffer or fills it
                    DroppedBytes += _position;
                    _position = 0;

                    // If incoming data itself exceeds buffer, truncate to most recent
                    if (data.Length > _buffer.Length)
                    {
                        DroppedBytes += data.Length - _buffer.Length;
                        data = data.Slice(data.Length - _buffer.Length);
                    }
                }
                else
                {
                    // Shift buffer to drop oldest bytes, keep most recent
                    DroppedBytes += overflow;
                    var keepBytes = _position - overflow;
                    Buffer.BlockCopy(_buffer, overflow, _buffer, 0, keepBytes);
                    _position = keepBytes;
                }
            }

            data.CopyTo(_buffer.AsSpan(_position));
            _position += data.Length;
        }

        public ReadOnlySpan<byte> GetData() => _buffer.AsSpan(0, _position);

        public void Reset() => _position = 0;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            if (_buffer is not null)
            {
                ArrayPool<byte>.Shared.Return(_buffer);
                _buffer = null!;
            }
        }
    }

    public MuxClient(string id, WebSocket webSocket)
    {
        Id = id;
        WebSocket = webSocket;
        _inputChannel = Channel.CreateBounded<OutputItem>(new BoundedChannelOptions(MaxQueuedItems)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        });
        _processor = ProcessLoopAsync(_cts.Token);
    }

    /// <summary>
    /// Queue raw terminal output for buffered delivery.
    /// Copies data into a pooled buffer owned by this client.
    /// </summary>
    internal void QueueOutput(string sessionId, int cols, int rows, SharedOutputBuffer buffer)
    {
        if (_cts.IsCancellationRequested)
        {
            buffer.Release();
            return;
        }
        if (WebSocket.State != WebSocketState.Open)
        {
            buffer.Release();
            return;
        }

        var queueCount = _inputChannel.Reader.Count;
        if (queueCount >= MaxQueuedItems - 1)
        {
            var newCount = Interlocked.Increment(ref _droppedFrameCount);
            if (newCount == 1)
            {
                Log.Warn(() => $"[MuxClient] {Id}: Input queue full, dropping items");
            }
        }

        if (!_inputChannel.Writer.TryWrite(new OutputItem(sessionId, cols, rows, buffer)))
        {
            buffer.Release();
        }
    }

    /// <summary>
    /// Set the active session for priority delivery.
    /// </summary>
    public void SetActiveSession(string? sessionId)
    {
        _activeSessionId = sessionId;
    }

    /// <summary>
    /// Check if frames were dropped and a resync is needed.
    /// </summary>
    public bool CheckAndResetDroppedFrames()
    {
        var count = Interlocked.Exchange(ref _droppedFrameCount, 0);
        return count > 0;
    }

    /// <summary>
    /// Queue session buffer removal (thread-safe, processed by loop).
    /// </summary>
    public void RemoveSession(string sessionId)
    {
        _sessionsToRemove.Enqueue(sessionId);
    }

    private async Task ProcessLoopAsync(CancellationToken ct)
    {
        var reader = _inputChannel.Reader;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                // 1. Process pending session removals (dispose buffers to return to pool)
                while (_sessionsToRemove.TryDequeue(out var sessionId))
                {
                    if (_sessionBuffers.Remove(sessionId, out var buffer))
                    {
                        buffer.Dispose();
                    }
                }

                // 2. Drain all immediately available items into buffers
                while (reader.TryRead(out var item))
                {
                    BufferOutput(item);
                }

                // 3. Flush what's due (active immediately, background if threshold/time)
                var now = Environment.TickCount64;
                await FlushDueBuffersAsync(now).ConfigureAwait(false);

                // 4. Wait for more data OR timeout (to check time-based flushes)
                try
                {
                    if (_loopTimeoutCts is null || !_loopTimeoutCts.TryReset())
                    {
                        _loopCtReg.Dispose();
                        _loopTimeoutCts?.Dispose();
                        _loopTimeoutCts = new CancellationTokenSource();
                        _loopCtReg = ct.UnsafeRegister(s_cancelCallback, _loopTimeoutCts);
                    }
                    _loopTimeoutCts.CancelAfter(LoopCheckInterval);
                    await reader.WaitToReadAsync(_loopTimeoutCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    // Timeout - continue to check time-based flushes
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown
        }
        catch (Exception ex)
        {
            Log.Exception(ex, $"MuxClient.ProcessLoop({Id})");
        }
    }

    private void BufferOutput(OutputItem item)
    {
        try
        {
            if (!_sessionBuffers.TryGetValue(item.SessionId, out var buffer))
            {
                buffer = new SessionBuffer();
                _sessionBuffers[item.SessionId] = buffer;
            }

            buffer.Write(item.Buffer.Span);
            buffer.LastCols = item.Cols;
            buffer.LastRows = item.Rows;
        }
        finally
        {
            item.Buffer.Release();
        }
    }

    private async Task FlushDueBuffersAsync(long nowTicks)
    {
        if (WebSocket.State != WebSocketState.Open) return;

        foreach (var (sessionId, buffer) in _sessionBuffers)
        {
            if (buffer.TotalBytes == 0) continue;

            bool shouldFlush;
            if (sessionId == _activeSessionId)
            {
                // Active: ALWAYS flush immediately
                shouldFlush = true;
            }
            else
            {
                // Background: flush if size threshold OR time elapsed
                var elapsedMs = nowTicks - buffer.LastFlushTicks;
                shouldFlush = buffer.TotalBytes >= FlushThresholdBytes
                           || elapsedMs >= (long)FlushInterval.TotalMilliseconds;
            }

            if (shouldFlush)
            {
                await FlushBufferAsync(sessionId, buffer).ConfigureAwait(false);
                buffer.LastFlushTicks = nowTicks;
            }
        }
    }

    private async Task FlushBufferAsync(string sessionId, SessionBuffer buffer)
    {
        if (buffer.TotalBytes == 0) return;

        // If data was dropped, notify client before sending (so client can request resync)
        if (buffer.DroppedBytes > 0)
        {
            var lossFrame = MuxProtocol.CreateDataLossFrame(sessionId, buffer.DroppedBytes);
            await SendFrameAsync(lossFrame).ConfigureAwait(false);
            Log.Warn(() => $"[MuxClient] {Id}: Session {sessionId} lost {buffer.DroppedBytes} bytes (buffer overflow)");
            buffer.DroppedBytes = 0;
        }

        // Get data directly from pooled buffer (zero-copy until frame creation)
        var data = buffer.GetData();

        // Rent buffer for frame, write, send, return
        var useCompression = data.Length > MuxProtocol.CompressionThreshold;
        var maxFrameSize = useCompression
            ? MuxProtocol.CompressedOutputHeaderSize + data.Length + 100
            : MuxProtocol.OutputHeaderSize + data.Length;

        var frameBuffer = ArrayPool<byte>.Shared.Rent(maxFrameSize);
        try
        {
            var frameLength = useCompression
                ? MuxProtocol.WriteCompressedOutputFrameInto(sessionId, buffer.LastCols, buffer.LastRows, data, frameBuffer)
                : MuxProtocol.WriteOutputFrameInto(sessionId, buffer.LastCols, buffer.LastRows, data, frameBuffer);

            // Send first, reset after - prevents data loss on send failure
            await SendFrameAsync(frameBuffer, frameLength).ConfigureAwait(false);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(frameBuffer);
        }

        buffer.Reset();
    }

    private async Task SendFrameAsync(byte[] data)
    {
        await _sendLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (WebSocket.State == WebSocketState.Open)
            {
                await WebSocket.SendAsync(data, WebSocketMessageType.Binary, true, CancellationToken.None).ConfigureAwait(false);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task SendFrameAsync(byte[] data, int length)
    {
        await _sendLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (WebSocket.State == WebSocketState.Open)
            {
                await WebSocket.SendAsync(data.AsMemory(0, length), WebSocketMessageType.Binary, true, CancellationToken.None).ConfigureAwait(false);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>
    /// Queue a pre-built frame to be sent immediately (fire-and-forget).
    /// Used for process events and foreground changes.
    /// </summary>
    public void QueueFrame(byte[] frame)
    {
        if (_cts.IsCancellationRequested) return;
        if (WebSocket.State != WebSocketState.Open) return;

        _ = SendFrameAsync(frame);
    }

    /// <summary>
    /// Send a frame directly (bypassing buffering) - used for init/sync frames.
    /// </summary>
    public async Task<bool> TrySendAsync(byte[] data)
    {
        if (WebSocket.State != WebSocketState.Open) return false;

        await _sendLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (WebSocket.State == WebSocketState.Open)
            {
                await WebSocket.SendAsync(data, WebSocketMessageType.Binary, true, CancellationToken.None).ConfigureAwait(false);
                return true;
            }
            return false;
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[MuxClient] {Id}: TrySend failed: {ex.Message}");
            return false;
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>
    /// Send a frame directly (bypassing buffering) - used for init/sync frames with pooled buffers.
    /// </summary>
    public async Task<bool> TrySendAsync(byte[] data, int length)
    {
        if (WebSocket.State != WebSocketState.Open) return false;

        await _sendLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (WebSocket.State == WebSocketState.Open)
            {
                await WebSocket.SendAsync(data.AsMemory(0, length), WebSocketMessageType.Binary, true, CancellationToken.None).ConfigureAwait(false);
                return true;
            }
            return false;
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[MuxClient] {Id}: TrySend failed: {ex.Message}");
            return false;
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _inputChannel.Writer.Complete();

        try
        {
            await _processor.ConfigureAwait(false);
        }
        catch
        {
            // Ignore shutdown errors
        }

        // Return all pooled buffers
        foreach (var buffer in _sessionBuffers.Values)
        {
            buffer.Dispose();
        }
        _sessionBuffers.Clear();

        _loopCtReg.Dispose();
        _loopTimeoutCts?.Dispose();
        _cts.Dispose();
        _sendLock.Dispose();
    }
}
