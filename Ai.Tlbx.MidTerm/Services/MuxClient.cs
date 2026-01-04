using System.Net.WebSockets;
using System.Threading.Channels;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class MuxClient : IAsyncDisposable
{
    private const int MaxQueuedFrames = 100;

    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Channel<byte[]> _outputQueue;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _outputProcessor;
    private int _droppedFrameCount;

    public string Id { get; }
    public WebSocket WebSocket { get; }

    public MuxClient(string id, WebSocket webSocket)
    {
        Id = id;
        WebSocket = webSocket;
        _outputQueue = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(MaxQueuedFrames)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.DropOldest
        });
        _outputProcessor = ProcessOutputQueueAsync(_cts.Token);
    }

    public void QueueOutput(byte[] frame)
    {
        if (_cts.IsCancellationRequested) return;
        if (WebSocket.State != WebSocketState.Open) return;

        // Track if we're dropping frames (queue full)
        var queueCount = _outputQueue.Reader.Count;
        if (queueCount >= MaxQueuedFrames - 1)
        {
            var newCount = Interlocked.Increment(ref _droppedFrameCount);
            if (newCount == 1)
            {
                DebugLogger.Log($"[MuxClient] {Id}: Queue full, dropping old frames");
            }
        }

        _outputQueue.Writer.TryWrite(frame);
    }

    /// <summary>
    /// Check if frames were dropped and a resync is needed.
    /// Returns true if resync should happen, and resets the counter.
    /// </summary>
    public bool CheckAndResetDroppedFrames()
    {
        var count = Interlocked.Exchange(ref _droppedFrameCount, 0);
        return count > 0;
    }

    private async Task ProcessOutputQueueAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var frame in _outputQueue.Reader.ReadAllAsync(ct))
            {
                if (WebSocket.State != WebSocketState.Open)
                {
                    // Connection closed, drain and exit
                    while (_outputQueue.Reader.TryRead(out _)) { }
                    break;
                }

                try
                {
                    await SendFrameAsync(frame).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    DebugLogger.Log($"[MuxClient] {Id}: Send error: {ex.Message}");
                    // Continue trying to send other frames
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            DebugLogger.LogException($"MuxClient.ProcessOutputQueue({Id})", ex);
        }
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
            DebugLogger.Log($"[MuxClient] {Id}: TrySend failed: {ex.Message}");
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
        _outputQueue.Writer.Complete();

        try
        {
            await _outputProcessor.ConfigureAwait(false);
        }
        catch
        {
        }

        _cts.Dispose();
        _sendLock.Dispose();
    }
}
