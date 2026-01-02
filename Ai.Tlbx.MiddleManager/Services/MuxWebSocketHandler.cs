using System.Net.WebSockets;
using System.Text;

namespace Ai.Tlbx.MiddleManager.Services;

public sealed class MuxWebSocketHandler
{
    private readonly ConHostSessionManager? _conHostManager;
    private readonly SessionManager? _directManager;
    private readonly ConHostMuxConnectionManager? _conHostMuxManager;
    private readonly MuxConnectionManager? _directMuxManager;

    public MuxWebSocketHandler(
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        ConHostMuxConnectionManager? conHostMuxManager,
        MuxConnectionManager? directMuxManager)
    {
        _conHostManager = conHostManager;
        _directManager = directManager;
        _conHostMuxManager = conHostMuxManager;
        _directMuxManager = directMuxManager;
    }

    public async Task HandleAsync(HttpContext context)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N");

        var client = _conHostMuxManager is not null
            ? _conHostMuxManager.AddClient(clientId, ws)
            : _directMuxManager!.AddClient(clientId, ws);

        try
        {
            await SendInitFrameAsync(client, clientId);
            await SendInitialBuffersAsync(client);
            await ProcessMessagesAsync(ws, clientId, client);
        }
        finally
        {
            await RemoveClientAsync(clientId);
            await CloseWebSocketAsync(ws);
        }
    }

    private async Task SendInitFrameAsync(MuxClient client, string clientId)
    {
        var initFrame = new byte[MuxProtocol.HeaderSize + 32];
        initFrame[0] = 0xFF;
        Encoding.ASCII.GetBytes(clientId.AsSpan(0, 8), initFrame.AsSpan(1, 8));
        Encoding.UTF8.GetBytes(clientId, initFrame.AsSpan(MuxProtocol.HeaderSize));
        await client.SendAsync(initFrame);
    }

    private async Task SendInitialBuffersAsync(MuxClient client)
    {
        if (_conHostManager is not null)
        {
            var sessions = _conHostManager.GetAllSessions();
            foreach (var sessionInfo in sessions)
            {
                var buffer = await _conHostManager.GetBufferAsync(sessionInfo.Id);
                if (buffer is not null && buffer.Length > 0)
                {
                    var frame = MuxProtocol.CreateOutputFrame(sessionInfo.Id, sessionInfo.Cols, sessionInfo.Rows, buffer);
                    await client.SendAsync(frame);
                }
            }
        }
        else
        {
            foreach (var session in _directManager!.Sessions)
            {
                var buffer = session.GetBuffer();
                if (!string.IsNullOrEmpty(buffer))
                {
                    var bufferBytes = Encoding.UTF8.GetBytes(buffer);
                    var frame = MuxProtocol.CreateOutputFrame(session.Id, session.Cols, session.Rows, bufferBytes);
                    await client.SendAsync(frame);
                }
            }
        }
    }

    private async Task ProcessMessagesAsync(WebSocket ws, string clientId, MuxClient client)
    {
        var receiveBuffer = new byte[MuxProtocol.MaxFrameSize];
        using var cts = new CancellationTokenSource();

        while (ws.State == WebSocketState.Open)
        {
            // Check if client needs resync (queue backed up due to slow connection)
            if (client.NeedsResync)
            {
                DebugLogger.Log($"[WS] {clientId}: Triggering full resync due to queue backup");
                client.PrepareForResync();
                await SendInitialBuffersAsync(client);
                client.ClearResyncFlag();
                DebugLogger.Log($"[WS] {clientId}: Resync complete");
            }

            WebSocketReceiveResult result;
            try
            {
                // Use timeout to periodically check resync flag
                using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                result = await ws.ReceiveAsync(receiveBuffer, timeoutCts.Token);
            }
            catch (OperationCanceledException)
            {
                // Timeout - loop back to check resync flag
                continue;
            }
            catch (WebSocketException)
            {
                break;
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType == WebSocketMessageType.Binary && result.Count >= MuxProtocol.HeaderSize)
            {
                await ProcessFrameAsync(new ReadOnlyMemory<byte>(receiveBuffer, 0, result.Count));
            }
        }
    }

    private async Task ProcessFrameAsync(ReadOnlyMemory<byte> data)
    {
        if (!MuxProtocol.TryParseFrame(data.Span, out var type, out var sessionId, out var payload))
        {
            return;
        }

        switch (type)
        {
            case MuxProtocol.TypeTerminalInput:
                if (payload.Length < 20)
                {
                    DebugLogger.Log($"[WS-INPUT] {sessionId}: {BitConverter.ToString(payload.ToArray())}");
                }

                if (_conHostMuxManager is not null)
                {
                    await _conHostMuxManager.HandleInputAsync(sessionId, new ReadOnlyMemory<byte>(payload.ToArray()));
                }
                else
                {
                    await _directMuxManager!.HandleInputAsync(sessionId, payload.ToArray());
                }
                break;

            case MuxProtocol.TypeResize:
                var (cols, rows) = MuxProtocol.ParseResizePayload(payload);
                if (_conHostMuxManager is not null)
                {
                    await _conHostMuxManager.HandleResizeAsync(sessionId, cols, rows);
                }
                else
                {
                    _directMuxManager!.HandleResize(sessionId, cols, rows);
                }
                break;
        }
    }

    private async Task RemoveClientAsync(string clientId)
    {
        if (_conHostMuxManager is not null)
        {
            await _conHostMuxManager.RemoveClientAsync(clientId);
        }
        else
        {
            await _directMuxManager!.RemoveClientAsync(clientId);
        }
    }

    private static async Task CloseWebSocketAsync(WebSocket ws)
    {
        if (ws.State == WebSocketState.Open)
        {
            try
            {
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
            }
            catch
            {
            }
        }
    }
}
