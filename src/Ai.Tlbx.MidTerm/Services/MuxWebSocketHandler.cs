using System.Net.WebSockets;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class MuxWebSocketHandler
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly TtyHostMuxConnectionManager _muxManager;
    private readonly SettingsService _settingsService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;

    public MuxWebSocketHandler(
        TtyHostSessionManager sessionManager,
        TtyHostMuxConnectionManager muxManager,
        SettingsService settingsService,
        AuthService authService,
        ShutdownService shutdownService)
    {
        _sessionManager = sessionManager;
        _muxManager = muxManager;
        _settingsService = settingsService;
        _authService = authService;
        _shutdownService = shutdownService;
    }

    public async Task HandleAsync(HttpContext context)
    {
        // SECURITY: Validate auth before accepting WebSocket
        var settings = _settingsService.Load();
        if (settings.AuthenticationEnabled && !string.IsNullOrEmpty(settings.PasswordHash))
        {
            var token = context.Request.Cookies["mm-session"];
            if (token is null || !_authService.ValidateSessionToken(token))
            {
                context.Response.StatusCode = 401;
                return;
            }
        }

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
        // Init frame format: [0xFF][clientId:8][protocolVersion:2][fullClientId:32]
        var initFrame = new byte[MuxProtocol.HeaderSize + 2 + 32];
        initFrame[0] = 0xFF;
        Encoding.ASCII.GetBytes(clientId.AsSpan(0, 8), initFrame.AsSpan(1, 8));
        BitConverter.TryWriteBytes(initFrame.AsSpan(MuxProtocol.HeaderSize, 2), MuxProtocol.ProtocolVersion);
        Encoding.UTF8.GetBytes(clientId, initFrame.AsSpan(MuxProtocol.HeaderSize + 2));
        await client.TrySendAsync(initFrame);
    }

    private async Task SendInitialBuffersAsync(MuxClient client)
    {
        var sessions = _sessionManager.GetAllSessions();

        foreach (var sessionInfo in sessions)
        {
            try
            {
                var buffer = await _sessionManager.GetBufferAsync(sessionInfo.Id);
                if (buffer is null || buffer.Length == 0) continue;

                // Chunk large buffers and compress each chunk
                for (var offset = 0; offset < buffer.Length; offset += MuxProtocol.CompressionChunkSize)
                {
                    var length = Math.Min(MuxProtocol.CompressionChunkSize, buffer.Length - offset);
                    var chunk = buffer.AsSpan(offset, length);

                    // Use compression for chunks over threshold
                    var frame = length > MuxProtocol.CompressionThreshold
                        ? MuxProtocol.CreateCompressedOutputFrame(sessionInfo.Id, sessionInfo.Cols, sessionInfo.Rows, chunk)
                        : MuxProtocol.CreateOutputFrame(sessionInfo.Id, sessionInfo.Cols, sessionInfo.Rows, chunk);

                    if (!await client.TrySendAsync(frame))
                    {
                        Log.Warn(() => $"[MuxHandler] Initial sync aborted for {sessionInfo.Id}: queue full");
                        return;
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error(() => $"[MuxHandler] Failed to get buffer for {sessionInfo.Id}: {ex.Message}");
            }
        }
    }

    private async Task ProcessMessagesAsync(WebSocket ws, string clientId, MuxClient client)
    {
        var receiveBuffer = new byte[MuxProtocol.MaxFrameSize];
        var shutdownToken = _shutdownService.Token;

        while (ws.State == WebSocketState.Open && !shutdownToken.IsCancellationRequested)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await ws.ReceiveAsync(receiveBuffer, shutdownToken);
            }
            catch (OperationCanceledException)
            {
                break;
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
            Log.Info(() => $"[MuxHandler] {client.Id}: Performing resync");

            // Send clear screen command
            var clearFrame = MuxProtocol.CreateClearScreenFrame();
            await client.TrySendAsync(clearFrame);

            // Send fresh buffers
            await SendInitialBuffersAsync(client);

            Log.Verbose(() => $"[MuxHandler] {client.Id}: Resync complete");
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[MuxHandler] {client.Id}: Resync failed: {ex.Message}");
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
                var inputBytes = payload.ToArray();
                if (inputBytes.Length < 20)
                {
                    Log.Verbose(() => $"[WS-INPUT] {sessionId}: {BitConverter.ToString(inputBytes)}");
                }
                await _muxManager.HandleInputAsync(sessionId, new ReadOnlyMemory<byte>(inputBytes));
                break;

            case MuxProtocol.TypeResize:
                var (cols, rows) = MuxProtocol.ParseResizePayload(payload);
                await _muxManager.HandleResizeAsync(sessionId, cols, rows);
                break;

            case MuxProtocol.TypeBufferRequest:
                await SendBufferForSessionAsync(client, sessionId);
                break;

            case MuxProtocol.TypeActiveSessionHint:
                client.SetActiveSession(sessionId);
                break;

            default:
                Log.Warn(() => $"[Mux] Unknown frame type 0x{type:X2} from {client.Id}");
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
                Log.Warn(() => $"[MuxHandler] BufferRequest for unknown session: {sessionId}");
                return;
            }

            var buffer = await _sessionManager.GetBufferAsync(sessionId);
            if (buffer is null)
            {
                Log.Warn(() => $"MuxHandler: BufferRequest for {sessionId}: IPC returned null (session disconnected?)");
                return;
            }
            if (buffer.Length > 0)
            {
                // Chunk and compress buffer response
                for (var offset = 0; offset < buffer.Length; offset += MuxProtocol.CompressionChunkSize)
                {
                    var length = Math.Min(MuxProtocol.CompressionChunkSize, buffer.Length - offset);
                    var chunk = buffer.AsSpan(offset, length);

                    var frame = length > MuxProtocol.CompressionThreshold
                        ? MuxProtocol.CreateCompressedOutputFrame(sessionId, session.Cols, session.Rows, chunk)
                        : MuxProtocol.CreateOutputFrame(sessionId, session.Cols, session.Rows, chunk);

                    await client.TrySendAsync(frame);
                }
                Log.Verbose(() => $"[MuxHandler] Sent buffer for {sessionId}: {buffer.Length} bytes");
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[MuxHandler] BufferRequest failed for {sessionId}: {ex.Message}");
        }
    }

    private async Task CloseWebSocketAsync(WebSocket ws)
    {
        if (ws.State == WebSocketState.Open)
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                var closeCode = _shutdownService.Token.IsCancellationRequested
                    ? (WebSocketCloseStatus)MuxProtocol.CloseServerShutdown
                    : WebSocketCloseStatus.NormalClosure;
                var closeMessage = _shutdownService.Token.IsCancellationRequested
                    ? "Server shutting down"
                    : null;
                await ws.CloseAsync(closeCode, closeMessage, cts.Token);
            }
            catch
            {
            }
        }
    }
}
