using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services.Share;
using Ai.Tlbx.MidTerm.Settings;

using Ai.Tlbx.MidTerm.Services.Sessions;
namespace Ai.Tlbx.MidTerm.Services.WebSockets;

public sealed class MuxWebSocketHandler
{
    private const int ReplayTailBytes = 256 * 1024;
    private readonly TtyHostSessionManager _sessionManager;
    private readonly TtyHostMuxConnectionManager _muxManager;
    private readonly SettingsService _settingsService;
    private readonly AuthService _authService;
    private readonly ShareGrantService _shareGrantService;
    private readonly ShutdownService _shutdownService;

    public MuxWebSocketHandler(
        TtyHostSessionManager sessionManager,
        TtyHostMuxConnectionManager muxManager,
        SettingsService settingsService,
        AuthService authService,
        ShareGrantService shareGrantService,
        ShutdownService shutdownService)
    {
        _sessionManager = sessionManager;
        _muxManager = muxManager;
        _settingsService = settingsService;
        _authService = authService;
        _shareGrantService = shareGrantService;
        _shutdownService = shutdownService;
    }

    public async Task HandleAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "";
        var shareAccess = RequestAccessContext.GetShareAccess(context);
        var isShareConnection = string.Equals(path, "/ws/share/mux", StringComparison.Ordinal);

        if (isShareConnection)
        {
            if (shareAccess is null || shareAccess.IsExpired(DateTime.UtcNow))
            {
                context.Response.StatusCode = 401;
                return;
            }
        }
        else
        {
            if (_authService.AuthenticateRequest(context.Request) == RequestAuthMethod.None)
            {
                context.Response.StatusCode = 401;
                return;
            }
        }

        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N");
        Timer? expiryTimer = null;
        Action<string>? revokeHandler = null;

        var client = _muxManager.AddClient(clientId, ws, shareAccess?.SessionId);

        try
        {
            if (shareAccess is not null)
            {
                revokeHandler = grantId =>
                {
                    if (string.Equals(grantId, shareAccess.GrantId, StringComparison.Ordinal))
                    {
                        try
                        {
                            ws.Abort();
                        }
                        catch
                        {
                        }
                    }
                };
                _shareGrantService.OnGrantRevoked += revokeHandler;

                var delay = shareAccess.ExpiresAtUtc - DateTime.UtcNow;
                if (delay <= TimeSpan.Zero)
                {
                    ws.Abort();
                    return;
                }

                expiryTimer = new Timer(_ =>
                {
                    try
                    {
                        ws.Abort();
                    }
                    catch
                    {
                    }
                }, null, delay, Timeout.InfiniteTimeSpan);
            }

            client.SuspendFlush();
            await SendInitFrameAsync(client, clientId);
            await SendInitialBuffersAsync(client, shareAccess?.SessionId);
            await client.TrySendAsync(MuxProtocol.CreateSyncCompleteFrame());
            client.ResumeFlush();
            await ProcessMessagesAsync(ws, clientId, client, shareAccess);
        }
        finally
        {
            if (revokeHandler is not null)
            {
                _shareGrantService.OnGrantRevoked -= revokeHandler;
            }
            expiryTimer?.Dispose();
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

    private static readonly byte[] SgrReset = Encoding.ASCII.GetBytes("\x1b[0m");

    private async Task SendSgrResetFrameAsync(MuxClient client, string sessionId, int cols, int rows)
    {
        var frame = MuxProtocol.CreateOutputFrame(sessionId, 0, cols, rows, SgrReset);
        await client.TrySendAsync(frame);
    }

    private async Task SendInitialBuffersAsync(MuxClient client, string? allowedSessionId)
    {
        var sessions = _sessionManager.GetAllSessions();

        foreach (var sessionInfo in sessions)
        {
            if (allowedSessionId is not null &&
                !string.Equals(sessionInfo.Id, allowedSessionId, StringComparison.Ordinal))
            {
                continue;
            }
            try
            {
                var snapshot = await _sessionManager.GetBufferAsync(
                    sessionInfo.Id,
                    ReplayTailBytes,
                    TerminalReplayReason.ReconnectTailReplay);
                if (snapshot is null || snapshot.Data.Length == 0) continue;

                await SendSgrResetFrameAsync(client, sessionInfo.Id, sessionInfo.Cols, sessionInfo.Rows);

                // Chunk large buffers and compress each chunk
                for (var offset = 0; offset < snapshot.Data.Length; offset += MuxProtocol.CompressionChunkSize)
                {
                    var length = Math.Min(MuxProtocol.CompressionChunkSize, snapshot.Data.Length - offset);
                    var chunk = snapshot.Data.AsSpan(offset, length);
                    var sequenceEndExclusive = snapshot.SequenceStart + (ulong)offset + (ulong)length;

                    // Use compression for chunks over threshold
                    var useCompression = length > MuxProtocol.CompressionThreshold;
                    var maxFrameSize = useCompression
                        ? MuxProtocol.CompressedOutputHeaderSize + length + 100
                        : MuxProtocol.OutputHeaderSize + length;

                    var frameBuffer = ArrayPool<byte>.Shared.Rent(maxFrameSize);
                    try
                    {
                        var frameLength = useCompression
                            ? MuxProtocol.WriteCompressedOutputFrameInto(sessionInfo.Id, sequenceEndExclusive, sessionInfo.Cols, sessionInfo.Rows, chunk, frameBuffer)
                            : MuxProtocol.WriteOutputFrameInto(sessionInfo.Id, sequenceEndExclusive, sessionInfo.Cols, sessionInfo.Rows, chunk, frameBuffer);

                        if (!await client.TrySendAsync(frameBuffer, frameLength))
                        {
                            Log.Warn(() => $"[MuxHandler] Initial sync aborted for {sessionInfo.Id}: queue full");
                            return;
                        }
                    }
                    finally
                    {
                        ArrayPool<byte>.Shared.Return(frameBuffer);
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error(() => $"[MuxHandler] Failed to get buffer for {sessionInfo.Id}: {ex.Message}");
            }
        }
    }

    private async Task ProcessMessagesAsync(
        WebSocket ws,
        string clientId,
        MuxClient client,
        ShareAccessContext? shareAccess)
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
                await ProcessFrameAsync(new ReadOnlyMemory<byte>(receiveBuffer, 0, result.Count), client, shareAccess);
            }

            var droppedSessions = client.DrainDroppedSessions();
            if (droppedSessions is not null)
            {
                foreach (var sessionId in droppedSessions)
                    {
                    var lossFrame = MuxProtocol.CreateDataLossFrame(sessionId, 0, TerminalReplayReason.MuxOverflow);
                    await client.TrySendAsync(lossFrame);
                }
            }
        }
    }

    private async Task ProcessFrameAsync(
        ReadOnlyMemory<byte> data,
        MuxClient client,
        ShareAccessContext? shareAccess)
    {
        if (!MuxProtocol.TryParseFrame(data.Span, out var type, out var sessionId, out var payload))
        {
            return;
        }

        if (shareAccess is not null &&
            !string.Equals(sessionId, shareAccess.SessionId, StringComparison.Ordinal))
        {
            return;
        }

        switch (type)
        {
            case MuxProtocol.TypeTerminalInput:
                if (shareAccess is not null && !ShareGrantService.CanWrite(shareAccess))
                {
                    return;
                }
                client.SetActiveSession(sessionId);
                var payloadMemory = data.Slice(MuxProtocol.HeaderSize);
                if (payloadMemory.Length < 20)
                {
                    Log.Verbose(() => $"[WS-INPUT] {sessionId}: {BitConverter.ToString(payloadMemory.ToArray())}");
                }
                await _muxManager.HandleInputAsync(sessionId, payloadMemory);
                break;

            case MuxProtocol.TypeResize:
                if (shareAccess is not null && !ShareGrantService.CanWrite(shareAccess))
                {
                    return;
                }
                var (cols, rows) = MuxProtocol.ParseResizePayload(payload);
                await _muxManager.HandleResizeAsync(sessionId, cols, rows);
                break;

            case MuxProtocol.TypeBufferRequest:
                await SendBufferForSessionAsync(client, sessionId);
                break;

            case MuxProtocol.TypeActiveSessionHint:
                client.SetActiveSession(sessionId);
                break;

            case MuxProtocol.TypePing:
                await HandlePingAsync(sessionId, data.Slice(MuxProtocol.HeaderSize), client);
                break;

            default:
                Log.Warn(() => $"[Mux] Unknown frame type 0x{type:X2} from {client.Id}");
                break;
        }
    }

    private async Task HandlePingAsync(string sessionId, ReadOnlyMemory<byte> payload, MuxClient client)
    {
        if (payload.Length < 1) return;

        var span = payload.Span;
        var mode = span[0];
        var pingData = payload.Length > 1 ? payload.Slice(1).ToArray() : Array.Empty<byte>();

        if (mode == 0)
        {
            // Server echo: respond with pong + diagnostics (flush delay + server input→output RTT)
            var flushDelay = (ushort)Math.Clamp(client.GetFlushDelay(sessionId), 0, 65535);
            var serverRtt = (ushort)Math.Clamp(_muxManager.GetServerRtt(sessionId), 0, 65535);
            var pong = new byte[MuxProtocol.HeaderSize + 1 + pingData.Length + 4];
            pong[0] = MuxProtocol.TypePong;
            MuxProtocol.WriteSessionId(pong.AsSpan(1, 8), sessionId);
            pong[MuxProtocol.HeaderSize] = 0; // mode = server
            if (pingData.Length > 0)
            {
                pingData.CopyTo(pong.AsSpan(MuxProtocol.HeaderSize + 1));
            }
            // Append diagnostics as uint16 LE: [flushDelay:2][serverRtt:2]
            var diagOffset = MuxProtocol.HeaderSize + 1 + pingData.Length;
            pong[diagOffset] = (byte)(flushDelay & 0xFF);
            pong[diagOffset + 1] = (byte)((flushDelay >> 8) & 0xFF);
            pong[diagOffset + 2] = (byte)(serverRtt & 0xFF);
            pong[diagOffset + 3] = (byte)((serverRtt >> 8) & 0xFF);
            await client.TrySendAsync(pong);
        }
        else if (mode == 1)
        {
            // MTHost echo: forward to mthost via IPC
            await _muxManager.HandlePingAsync(sessionId, pingData, client);
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

            var snapshot = await _sessionManager.GetBufferAsync(
                sessionId,
                ReplayTailBytes,
                TerminalReplayReason.BufferRefreshTailReplay);
            if (snapshot is null)
            {
                Log.Warn(() => $"MuxHandler: BufferRequest for {sessionId}: IPC returned null (session disconnected?)");
                return;
            }
            if (snapshot.Data.Length > 0)
            {
                await SendSgrResetFrameAsync(client, sessionId, session.Cols, session.Rows);

                // Chunk and compress buffer response
                for (var offset = 0; offset < snapshot.Data.Length; offset += MuxProtocol.CompressionChunkSize)
                {
                    var length = Math.Min(MuxProtocol.CompressionChunkSize, snapshot.Data.Length - offset);
                    var chunk = snapshot.Data.AsSpan(offset, length);
                    var sequenceEndExclusive = snapshot.SequenceStart + (ulong)offset + (ulong)length;

                    var useCompression = length > MuxProtocol.CompressionThreshold;
                    var maxFrameSize = useCompression
                        ? MuxProtocol.CompressedOutputHeaderSize + length + 100
                        : MuxProtocol.OutputHeaderSize + length;

                    var frameBuffer = ArrayPool<byte>.Shared.Rent(maxFrameSize);
                    try
                    {
                        var frameLength = useCompression
                            ? MuxProtocol.WriteCompressedOutputFrameInto(sessionId, sequenceEndExclusive, session.Cols, session.Rows, chunk, frameBuffer)
                            : MuxProtocol.WriteOutputFrameInto(sessionId, sequenceEndExclusive, session.Cols, session.Rows, chunk, frameBuffer);

                        await client.TrySendAsync(frameBuffer, frameLength);
                    }
                    finally
                    {
                        ArrayPool<byte>.Shared.Return(frameBuffer);
                    }
                }
                Log.Verbose(() => $"[MuxHandler] Sent buffer for {sessionId}: {snapshot.Data.Length} bytes");
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
