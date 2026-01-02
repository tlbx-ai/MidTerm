using System.Net.WebSockets;
using System.Threading.Channels;

namespace Ai.Tlbx.MiddleManager.Services;

public sealed class MuxClient : IAsyncDisposable
{
    private const int ResyncThreshold = 200;

    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Channel<byte[]> _outputQueue;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _outputProcessor;
    private volatile bool _needsResync;

    public string Id { get; }
    public WebSocket WebSocket { get; }
    public bool NeedsResync => _needsResync;

    public MuxClient(string id, WebSocket webSocket)
    {
        Id = id;
        WebSocket = webSocket;
        // Unbounded channel - we control backpressure manually via resync
        _outputQueue = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });
        _outputProcessor = ProcessOutputQueueAsync(_cts.Token);
    }

    public void QueueOutput(byte[] frame)
    {
        if (_cts.IsCancellationRequested || _needsResync) return;

        // Check if queue is backing up - trigger resync if needed
        var count = _outputQueue.Reader.Count;
        if (count >= ResyncThreshold)
        {
            _needsResync = true;
            DebugLogger.Log($"[MuxClient] {Id}: Queue backed up ({count} frames), triggering resync");
            // Don't write this frame - client will get full buffer on resync
            return;
        }

        _outputQueue.Writer.TryWrite(frame);
    }

    public void PrepareForResync()
    {
        // Drain the queue - we're about to send fresh buffer content
        while (_outputQueue.Reader.TryRead(out _)) { }
        DebugLogger.Log($"[MuxClient] {Id}: Queue cleared for resync");
    }

    public void ClearResyncFlag()
    {
        _needsResync = false;
    }

    private async Task ProcessOutputQueueAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var frame in _outputQueue.Reader.ReadAllAsync(ct))
            {
                await SendDirectAsync(frame).ConfigureAwait(false);
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

    private async Task SendDirectAsync(byte[] data)
    {
        await _sendLock.WaitAsync();
        try
        {
            if (WebSocket.State == WebSocketState.Open)
            {
                await WebSocket.SendAsync(data, WebSocketMessageType.Binary, true, CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            DebugLogger.Log($"[MuxClient] {Id}: Send failed: {ex.Message}");
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async Task SendAsync(byte[] data)
    {
        await _sendLock.WaitAsync();
        try
        {
            if (WebSocket.State == WebSocketState.Open)
            {
                await WebSocket.SendAsync(data, WebSocketMessageType.Binary, true, CancellationToken.None);
            }
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
