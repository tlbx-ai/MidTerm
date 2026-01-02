using System.Net.WebSockets;
using System.Threading.Channels;

namespace Ai.Tlbx.MiddleManager.Services;

public sealed class MuxClient : IAsyncDisposable
{
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Channel<byte[]> _outputQueue;
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _outputProcessor;

    public string Id { get; }
    public WebSocket WebSocket { get; }

    public MuxClient(string id, WebSocket webSocket)
    {
        Id = id;
        WebSocket = webSocket;
        _outputQueue = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });
        _outputProcessor = ProcessOutputQueueAsync(_cts.Token);
    }

    public void QueueOutput(byte[] frame)
    {
        if (_cts.IsCancellationRequested) return;
        if (WebSocket.State != WebSocketState.Open) return;

        _outputQueue.Writer.TryWrite(frame);
    }

    private async Task ProcessOutputQueueAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var frame in _outputQueue.Reader.ReadAllAsync(ct))
            {
                if (WebSocket.State != WebSocketState.Open)
                {
                    // Connection closed, drain remaining frames silently
                    while (_outputQueue.Reader.TryRead(out _)) { }
                    break;
                }

                await SendFrameAsync(frame).ConfigureAwait(false);
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
