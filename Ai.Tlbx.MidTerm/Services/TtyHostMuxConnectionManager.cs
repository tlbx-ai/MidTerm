using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Channels;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// WebSocket mux manager for con-host mode.
/// </summary>
public sealed class TtyHostMuxConnectionManager
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly ConcurrentDictionary<string, MuxClient> _clients = new();
    private const int MaxQueuedOutputs = 1000;
    private readonly Channel<(string sessionId, int cols, int rows, byte[] data)> _outputQueue =
        Channel.CreateBounded<(string, int, int, byte[])>(
            new BoundedChannelOptions(MaxQueuedOutputs) { FullMode = BoundedChannelFullMode.DropOldest });
    private Task? _outputProcessor;
    private CancellationTokenSource? _cts;

    public TtyHostMuxConnectionManager(TtyHostSessionManager sessionManager)
    {
        _sessionManager = sessionManager;
        _sessionManager.OnOutput += HandleOutput;

        _cts = new CancellationTokenSource();
        _outputProcessor = ProcessOutputQueueAsync(_cts.Token);
    }

    private void HandleOutput(string sessionId, int cols, int rows, ReadOnlyMemory<byte> data)
    {
        _outputQueue.Writer.TryWrite((sessionId, cols, rows, data.ToArray()));
    }

    private async Task ProcessOutputQueueAsync(CancellationToken ct)
    {
        await foreach (var (sessionId, cols, rows, data) in _outputQueue.Reader.ReadAllAsync(ct))
        {
            if (data.Length < 50)
            {
                DebugLogger.Log($"[WS-OUTPUT] {sessionId}: {BitConverter.ToString(data)}");
            }

            // Use compression for payloads over threshold
            var frame = data.Length > MuxProtocol.CompressionThreshold
                ? MuxProtocol.CreateCompressedOutputFrame(sessionId, cols, rows, data)
                : MuxProtocol.CreateOutputFrame(sessionId, cols, rows, data);

            // Queue to each client - non-blocking, each client has its own queue
            foreach (var client in _clients.Values)
            {
                if (client.WebSocket.State == WebSocketState.Open)
                {
                    client.QueueOutput(frame);
                }
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

        // Use compression for payloads over threshold
        var frame = data.Length > MuxProtocol.CompressionThreshold
            ? MuxProtocol.CreateCompressedOutputFrame(sessionId, cols, rows, data.Span)
            : MuxProtocol.CreateOutputFrame(sessionId, cols, rows, data.Span);

        // Queue to each client - non-blocking
        foreach (var client in _clients.Values)
        {
            if (client.WebSocket.State == WebSocketState.Open)
            {
                client.QueueOutput(frame);
            }
        }
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
