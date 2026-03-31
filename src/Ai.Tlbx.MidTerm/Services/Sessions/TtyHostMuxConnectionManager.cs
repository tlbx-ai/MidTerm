using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.WebSockets;
using Ai.Tlbx.MidTerm.Settings;
namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// WebSocket mux manager for con-host mode.
/// </summary>
public sealed class TtyHostMuxConnectionManager
{
    private readonly record struct PooledOutputItem(
        string SessionId,
        ulong SequenceEndExclusive,
        int Cols,
        int Rows,
        SharedOutputBuffer Buffer);

    private readonly TtyHostSessionManager _sessionManager;
    private readonly ConcurrentDictionary<string, MuxClient> _clients = new();
    private readonly ConcurrentDictionary<string, long> _inputTimestamps = new();
    private readonly ConcurrentDictionary<string, int> _lastServerRttMs = new();
    private const int MaxQueuedOutputs = 1000;
    private readonly Channel<PooledOutputItem> _outputQueue =
        Channel.CreateBounded<PooledOutputItem>(
            new BoundedChannelOptions(MaxQueuedOutputs) { FullMode = BoundedChannelFullMode.DropWrite });
    private Task? _outputProcessor;
    private CancellationTokenSource? _cts;
    private readonly SettingsService _settingsService;
    private readonly Action<string, ulong, int, int, ReadOnlyMemory<byte>> _outputHandler;
    private readonly Action<string> _sessionClosedHandler;
    private readonly Action<string, ForegroundChangePayload> _foregroundChangedHandler;
    private readonly string _settingsListenerId;
    private TerminalResumeModeSetting _resumeMode;
    private bool _disposed;

    public TtyHostMuxConnectionManager(TtyHostSessionManager sessionManager, SettingsService settingsService)
    {
        _sessionManager = sessionManager;
        _settingsService = settingsService;
        _resumeMode = settingsService.Load().ResumeMode;
        _settingsListenerId = settingsService.AddSettingsListener(settings => _resumeMode = settings.ResumeMode);
        _outputHandler = HandleOutput;
        _sessionClosedHandler = HandleSessionClosed;
        _foregroundChangedHandler = HandleForegroundChanged;
        _sessionManager.OnOutput += _outputHandler;
        _sessionManager.OnSessionClosed += _sessionClosedHandler;
        _sessionManager.OnForegroundChanged += _foregroundChangedHandler;

        _cts = new CancellationTokenSource();
        _outputProcessor = ProcessOutputQueueAsync(_cts.Token);
    }

    private void HandleSessionClosed(string sessionId)
    {
        _inputTimestamps.TryRemove(sessionId, out _);
        _lastServerRttMs.TryRemove(sessionId, out _);
        MuxProtocol.ClearSessionCache(sessionId);

        foreach (var client in _clients.Values)
        {
            client.RemoveSession(sessionId);
        }
    }

    private void HandleOutput(string sessionId, ulong sequenceStart, int cols, int rows, ReadOnlyMemory<byte> data)
    {
        if (_inputTimestamps.TryRemove(sessionId, out var inputTicks))
        {
            _lastServerRttMs[sessionId] = (int)(Environment.TickCount64 - inputTicks);
        }

        var shared = SharedOutputBuffer.Rent(data.Length);
        data.Span.CopyTo(shared.WriteSpan);

        var sequenceEndExclusive = sequenceStart + (ulong)data.Length;
        if (!_outputQueue.Writer.TryWrite(new PooledOutputItem(sessionId, sequenceEndExclusive, cols, rows, shared)))
        {
            Log.Warn(() => $"[MuxManager] Output queue full, dropping frame for {sessionId} ({data.Length} bytes)");
            foreach (var client in _clients.Values)
            {
                if (client.WebSocket.State == WebSocketState.Open)
                {
                    client.QueueFrame(MuxProtocol.CreateDataLossFrame(sessionId, data.Length, TerminalReplayReason.MuxOverflow), sessionId);
                }
            }
            shared.Release();
        }
    }

    private void HandleForegroundChanged(string sessionId, ForegroundChangePayload payload)
    {
        var jsonPayload = JsonSerializer.SerializeToUtf8Bytes(payload, TtyHostJsonContext.Default.ForegroundChangePayload);
        var frame = MuxProtocol.CreateForegroundChangeFrame(sessionId, jsonPayload);

        foreach (var client in _clients.Values)
        {
            if (client.WebSocket.State == WebSocketState.Open)
            {
                client.QueueFrame(frame, sessionId);
            }
        }
    }

    private async Task ProcessOutputQueueAsync(CancellationToken ct)
    {
        await foreach (var item in _outputQueue.Reader.ReadAllAsync(ct))
        {
            try
            {
                if (item.Buffer.Length < 50)
                {
                    Log.Verbose(() => $"[WS-OUTPUT] {item.SessionId}: {BitConverter.ToString(item.Buffer.Memory[..item.Buffer.Length].Span.ToArray())}");
                }

                // Queue raw data to each client - clients handle buffering and framing
                foreach (var client in _clients.Values)
                {
                    if (client.WebSocket.State == WebSocketState.Open)
                    {
                        item.Buffer.AddRef();
                        client.QueueOutput(item.SessionId, item.SequenceEndExclusive, item.Cols, item.Rows, item.Buffer);
                    }
                }
            }
            finally
            {
                item.Buffer.Release();
            }
        }
    }

    public MuxClient AddClient(string clientId, WebSocket webSocket, string? allowedSessionId = null)
    {
        var client = new MuxClient(clientId, webSocket, GetResumeMode, allowedSessionId);
        _clients[clientId] = client;
        return client;
    }

    private TerminalResumeModeSetting GetResumeMode() => _resumeMode;

    public async Task RemoveClientAsync(string clientId)
    {
        if (_clients.TryRemove(clientId, out var client))
        {
            await client.DisposeAsync().ConfigureAwait(false);
        }
    }

    public async Task HandleInputAsync(string sessionId, ReadOnlyMemory<byte> data)
    {
        _inputTimestamps[sessionId] = Environment.TickCount64;
        await _sessionManager.SendInputAsync(sessionId, data).ConfigureAwait(false);
    }

    public int GetServerRtt(string sessionId)
    {
        return _lastServerRttMs.TryGetValue(sessionId, out var rtt) ? rtt : -1;
    }

    public async Task HandlePingAsync(string sessionId, byte[] pingData, MuxClient client)
    {
        var pongData = await _sessionManager.PingAsync(sessionId, pingData);
        if (pongData is null) return;

        var pong = new byte[MuxProtocol.HeaderSize + 1 + pongData.Length];
        pong[0] = MuxProtocol.TypePong;
        MuxProtocol.WriteSessionId(pong.AsSpan(1, 8), sessionId);
        pong[MuxProtocol.HeaderSize] = 1; // mode = mthost
        pongData.CopyTo(pong.AsSpan(MuxProtocol.HeaderSize + 1));
        await client.TrySendAsync(pong);
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
        var sequenceEndExclusive = _sessionManager.GetTransportRuntimeSnapshot(sessionId).SourceSeq;

        // Queue raw data to each client - clients handle buffering and framing
        var buffer = SharedOutputBuffer.Rent(data.Length);
        data.Span.CopyTo(buffer.WriteSpan);
        foreach (var client in _clients.Values)
        {
            if (client.WebSocket.State == WebSocketState.Open)
            {
                buffer.AddRef();
                client.QueueOutput(sessionId, sequenceEndExclusive, cols, rows, buffer);
            }
        }
        buffer.Release();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;

        _cts?.Cancel();
        if (_outputProcessor is not null)
        {
            try { await _outputProcessor.ConfigureAwait(false); } catch { }
        }
        _outputQueue.Writer.Complete();
        _cts?.Dispose();

        _sessionManager.OnOutput -= _outputHandler;
        _sessionManager.OnSessionClosed -= _sessionClosedHandler;
        _sessionManager.OnForegroundChanged -= _foregroundChangedHandler;
        _settingsService.RemoveSettingsListener(_settingsListenerId);
    }
}
