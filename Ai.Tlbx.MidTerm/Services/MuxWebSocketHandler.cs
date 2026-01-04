using System.Net.WebSockets;
using System.Text;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class MuxWebSocketHandler
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly TtyHostMuxConnectionManager _muxManager;

    public MuxWebSocketHandler(
        TtyHostSessionManager sessionManager,
        TtyHostMuxConnectionManager muxManager)
    {
        _sessionManager = sessionManager;
        _muxManager = muxManager;
    }

    public async Task HandleAsync(HttpContext context)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N");

        var client = _muxManager.AddClient(clientId, ws);

        try
        {
            await SendInitFrameAsync(client, clientId);
            await SendInitialBuffersAsync(client);
            await ProcessMessagesAsync(ws, clientId, client);
        }
        finally
        {
            await _muxManager.RemoveClientAsync(clientId);
            await CloseWebSocketAsync(ws);
        }
    }

    private async Task SendInitFrameAsync(MuxClient client, string clientId)
    {
        var initFrame = new byte[MuxProtocol.HeaderSize + 32];
        initFrame[0] = 0xFF;
        Encoding.ASCII.GetBytes(clientId.AsSpan(0, 8), initFrame.AsSpan(1, 8));
        Encoding.UTF8.GetBytes(clientId, initFrame.AsSpan(MuxProtocol.HeaderSize));
        await client.TrySendAsync(initFrame);
    }

    private async Task SendInitialBuffersAsync(MuxClient client)
    {
        const int ChunkSize = 32 * 1024; // 32KB chunks to avoid memory spikes
        var sessions = _sessionManager.GetAllSessions();

        foreach (var sessionInfo in sessions)
        {
            try
            {
                var buffer = await _sessionManager.GetBufferAsync(sessionInfo.Id);
                if (buffer is null || buffer.Length == 0) continue;

                // Chunk large buffers for flow control
                for (var offset = 0; offset < buffer.Length; offset += ChunkSize)
                {
                    var length = Math.Min(ChunkSize, buffer.Length - offset);
                    var chunk = buffer.AsSpan(offset, length);
                    var frame = MuxProtocol.CreateOutputFrame(sessionInfo.Id, sessionInfo.Cols, sessionInfo.Rows, chunk);
                    if (!await client.TrySendAsync(frame))
                    {
                        // Client queue full, stop sending to this client
                        DebugLogger.Log($"[MuxHandler] Initial sync aborted for {sessionInfo.Id}: queue full");
                        return;
                    }
                }
            }
            catch (Exception ex)
            {
                DebugLogger.Log($"[MuxHandler] Failed to get buffer for {sessionInfo.Id}: {ex.Message}");
            }
        }
    }

    private async Task ProcessMessagesAsync(WebSocket ws, string clientId, MuxClient client)
    {
        var receiveBuffer = new byte[MuxProtocol.MaxFrameSize];

        while (ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await ws.ReceiveAsync(receiveBuffer, CancellationToken.None);
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
                await ProcessFrameAsync(new ReadOnlyMemory<byte>(receiveBuffer, 0, result.Count), client);
            }

            // After processing input, check if resync needed (frames were dropped)
            if (client.CheckAndResetDroppedFrames())
            {
                await PerformResyncAsync(client);
            }
        }
    }

    private async Task PerformResyncAsync(MuxClient client)
    {
        try
        {
            DebugLogger.Log($"[MuxHandler] {client.Id}: Performing resync");

            // Send clear screen command
            var clearFrame = MuxProtocol.CreateClearScreenFrame();
            await client.TrySendAsync(clearFrame);

            // Send fresh buffers
            await SendInitialBuffersAsync(client);

            DebugLogger.Log($"[MuxHandler] {client.Id}: Resync complete");
        }
        catch (Exception ex)
        {
            DebugLogger.Log($"[MuxHandler] {client.Id}: Resync failed: {ex.Message}");
            // Don't rethrow - keep the connection alive
        }
    }

    private async Task ProcessFrameAsync(ReadOnlyMemory<byte> data, MuxClient client)
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
                await _muxManager.HandleInputAsync(sessionId, new ReadOnlyMemory<byte>(payload.ToArray()));
                break;

            case MuxProtocol.TypeResize:
                var (cols, rows) = MuxProtocol.ParseResizePayload(payload);
                await _muxManager.HandleResizeAsync(sessionId, cols, rows);
                break;

            case MuxProtocol.TypeBufferRequest:
                await SendBufferForSessionAsync(client, sessionId);
                break;
        }
    }

    private async Task SendBufferForSessionAsync(MuxClient client, string sessionId)
    {
        try
        {
            var session = _sessionManager.GetSession(sessionId);
            if (session is null)
            {
                DebugLogger.Log($"[MuxHandler] BufferRequest for unknown session: {sessionId}");
                return;
            }

            var buffer = await _sessionManager.GetBufferAsync(sessionId);
            if (buffer is not null && buffer.Length > 0)
            {
                var frame = MuxProtocol.CreateOutputFrame(sessionId, session.Cols, session.Rows, buffer);
                await client.TrySendAsync(frame);
                DebugLogger.Log($"[MuxHandler] Sent buffer for {sessionId}: {buffer.Length} bytes");
            }
        }
        catch (Exception ex)
        {
            DebugLogger.Log($"[MuxHandler] BufferRequest failed for {sessionId}: {ex.Message}");
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
