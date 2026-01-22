using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// WebSocket mux manager for con-host mode.
/// </summary>
public sealed class TtyHostMuxConnectionManager
{
    private readonly record struct PooledOutputItem(
        string SessionId, int Cols, int Rows,
        byte[] Buffer, int Length)
    {
        public ReadOnlySpan<byte> Data => Buffer.AsSpan(0, Length);
        public void Return() => ArrayPool<byte>.Shared.Return(Buffer);
    }

    private readonly TtyHostSessionManager _sessionManager;
    private readonly ConcurrentDictionary<string, MuxClient> _clients = new();
    private const int MaxQueuedOutputs = 1000;
    private readonly Channel<PooledOutputItem> _outputQueue =
        Channel.CreateBounded<PooledOutputItem>(
            new BoundedChannelOptions(MaxQueuedOutputs) { FullMode = BoundedChannelFullMode.DropOldest });
    private Task? _outputProcessor;
    private CancellationTokenSource? _cts;

    public TtyHostMuxConnectionManager(TtyHostSessionManager sessionManager)
    {
        _sessionManager = sessionManager;
        _sessionManager.OnOutput += HandleOutput;
        _sessionManager.OnSessionClosed += HandleSessionClosed;
        _sessionManager.OnForegroundChanged += HandleForegroundChanged;

        _cts = new CancellationTokenSource();
        _outputProcessor = ProcessOutputQueueAsync(_cts.Token);
    }

    private void HandleSessionClosed(string sessionId)
    {
        foreach (var client in _clients.Values)
        {
            client.RemoveSession(sessionId);
        }
    }

    private void HandleOutput(string sessionId, int cols, int rows, ReadOnlyMemory<byte> data)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(data.Length);
        data.Span.CopyTo(buffer);
        _outputQueue.Writer.TryWrite(new PooledOutputItem(sessionId, cols, rows, buffer, data.Length));
    }

    private void HandleForegroundChanged(string sessionId, ForegroundChangePayload payload)
    {
        var jsonPayload = JsonSerializer.SerializeToUtf8Bytes(payload, TtyHostJsonContext.Default.ForegroundChangePayload);
        var frame = MuxProtocol.CreateForegroundChangeFrame(sessionId, jsonPayload);

        foreach (var client in _clients.Values)
        {
            if (client.WebSocket.State == WebSocketState.Open)
            {
                client.QueueFrame(frame);
            }
        }
    }

    private async Task ProcessOutputQueueAsync(CancellationToken ct)
    {
        await foreach (var item in _outputQueue.Reader.ReadAllAsync(ct))
        {
            try
            {
                if (item.Length < 50)
                {
                    Log.Verbose(() => $"[WS-OUTPUT] {item.SessionId}: {BitConverter.ToString(item.Buffer, 0, item.Length)}");
                }

                // Queue raw data to each client - clients handle buffering and framing
                foreach (var client in _clients.Values)
                {
                    if (client.WebSocket.State == WebSocketState.Open)
                    {
                        client.QueueOutput(item.SessionId, item.Cols, item.Rows, item.Buffer, item.Length);
                    }
                }
            }
            finally
            {
                item.Return();
            }
        }
    }

    public MuxClient AddClient(string clientId, WebSocket webSocket)
    {
        var client = new MuxClient(clientId, webSocket);
        _clients[clientId] = client;
        return client;
    }

    public async Task RemoveClientAsync(string clientId)
    {
        if (_clients.TryRemove(clientId, out var client))
        {
            await client.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async Task HandleInputAsync(string sessionId, ReadOnlyMemory<byte> data)
    {
        await _sessionManager.SendInputAsync(sessionId, data).ConfigureAwait(false);
    }

    public async Task HandleResizeAsync(string sessionId, int cols, int rows)
    {
        await _sessionManager.ResizeSessionAsync(sessionId, cols, rows).ConfigureAwait(false);
    }

    public void BroadcastTerminalOutput(string sessionId, ReadOnlyMemory<byte> data)
    {
        var sessionInfo = _sessionManager.GetSession(sessionId);
        var cols = sessionInfo?.Cols ?? 80;
        var rows = sessionInfo?.Rows ?? 24;

        // Queue raw data to each client - clients handle buffering and framing
        var buffer = ArrayPool<byte>.Shared.Rent(data.Length);
        data.Span.CopyTo(buffer);
        foreach (var client in _clients.Values)
        {
            if (client.WebSocket.State == WebSocketState.Open)
            {
                client.QueueOutput(sessionId, cols, rows, buffer, data.Length);
            }
        }
        ArrayPool<byte>.Shared.Return(buffer);
    }

    public async ValueTask DisposeAsync()
    {
        _cts?.Cancel();
        if (_outputProcessor is not null)
        {
            try { await _outputProcessor.ConfigureAwait(false); } catch { }
        }
        _outputQueue.Writer.Complete();
        _cts?.Dispose();
    }
}
