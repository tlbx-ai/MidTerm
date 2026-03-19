using System.Net.WebSockets;
using Ai.Tlbx.MidTerm.Services.WebSockets;

namespace Ai.Tlbx.MidTerm.Services.Hub;

public sealed class HubMuxWebSocketHandler
{
    private readonly HubService _hubService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;

    public HubMuxWebSocketHandler(
        HubService hubService,
        AuthService authService,
        ShutdownService shutdownService)
    {
        _hubService = hubService;
        _authService = authService;
        _shutdownService = shutdownService;
    }

    public async Task HandleAsync(HttpContext context)
    {
        if (_authService.AuthenticateRequest(context.Request) == RequestAuthMethod.None)
        {
            context.Response.StatusCode = 401;
            return;
        }

        var machineId = context.Request.Query["machineId"].FirstOrDefault();
        var sessionId = context.Request.Query["sessionId"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(machineId) || string.IsNullOrWhiteSpace(sessionId))
        {
            context.Response.StatusCode = 400;
            await context.Response.WriteAsync("machineId and sessionId are required.");
            return;
        }

        using var localSocket = await context.WebSockets.AcceptWebSocketAsync();
        using var remoteSocket = new ClientWebSocket();
        var machine = _hubService.GetMachine(machineId);
        if (machine is null)
        {
            await CloseBadRequestAsync(localSocket, "Hub machine not found.");
            return;
        }

        try
        {
            await _hubService.ConfigureRemoteWebSocketAsync(machineId, remoteSocket);
            var remoteUri = BuildRemoteMuxUri(machine.BaseUrl);
            await remoteSocket.ConnectAsync(remoteUri, _shutdownService.Token);
        }
        catch (Exception ex)
        {
            await CloseBadRequestAsync(localSocket, ex.Message);
            return;
        }

        using var bridgeCts = CancellationTokenSource.CreateLinkedTokenSource(_shutdownService.Token);
        var localToRemote = BridgeLocalToRemoteAsync(localSocket, remoteSocket, bridgeCts.Token);
        var remoteToLocal = BridgeRemoteToLocalAsync(localSocket, remoteSocket, sessionId, bridgeCts.Token);
        await Task.WhenAny(localToRemote, remoteToLocal);
        bridgeCts.Cancel();
        await Task.WhenAll(SwallowAsync(localToRemote), SwallowAsync(remoteToLocal));
        await TryCloseAsync(remoteSocket);
        await TryCloseAsync(localSocket);
    }

    private static Uri BuildRemoteMuxUri(string baseUrl)
    {
        var builder = new UriBuilder(baseUrl);
        builder.Scheme = builder.Scheme.Equals("http", StringComparison.OrdinalIgnoreCase) ? "ws" : "wss";
        builder.Path = "/ws/mux";
        builder.Query = string.Empty;
        return builder.Uri;
    }

    private static async Task BridgeLocalToRemoteAsync(
        WebSocket localSocket,
        ClientWebSocket remoteSocket,
        CancellationToken ct)
    {
        var buffer = new byte[MuxProtocol.MaxFrameSize];
        while (!ct.IsCancellationRequested &&
               localSocket.State == WebSocketState.Open &&
               remoteSocket.State == WebSocketState.Open)
        {
            var result = await localSocket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType != WebSocketMessageType.Binary || result.Count == 0)
            {
                continue;
            }

            await remoteSocket.SendAsync(
                new ArraySegment<byte>(buffer, 0, result.Count),
                WebSocketMessageType.Binary,
                result.EndOfMessage,
                ct);
        }
    }

    private static async Task BridgeRemoteToLocalAsync(
        WebSocket localSocket,
        ClientWebSocket remoteSocket,
        string sessionId,
        CancellationToken ct)
    {
        var buffer = new byte[MuxProtocol.MaxFrameSize];
        while (!ct.IsCancellationRequested &&
               localSocket.State == WebSocketState.Open &&
               remoteSocket.State == WebSocketState.Open)
        {
            var result = await remoteSocket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.MessageType != WebSocketMessageType.Binary || result.Count == 0)
            {
                continue;
            }

            if (ShouldForwardFrame(buffer.AsSpan(0, result.Count), sessionId))
            {
                await localSocket.SendAsync(
                    new ArraySegment<byte>(buffer, 0, result.Count),
                    WebSocketMessageType.Binary,
                    result.EndOfMessage,
                    ct);
            }
        }
    }

    private static bool ShouldForwardFrame(ReadOnlySpan<byte> frame, string sessionId)
    {
        if (frame.Length == 0)
        {
            return false;
        }

        if (frame[0] == 0xff || frame[0] == MuxProtocol.TypeSyncComplete)
        {
            return true;
        }

        return MuxProtocol.TryParseFrame(frame, out _, out var parsedSessionId, out _) &&
               string.Equals(parsedSessionId, sessionId, StringComparison.Ordinal);
    }

    private static async Task CloseBadRequestAsync(WebSocket socket, string message)
    {
        if (socket.State == WebSocketState.Open)
        {
            await socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, message, CancellationToken.None);
        }
    }

    private static async Task TryCloseAsync(WebSocket socket)
    {
        if (socket.State == WebSocketState.Open)
        {
            try
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
            }
            catch
            {
            }
        }
    }

    private static async Task SwallowAsync(Task task)
    {
        try
        {
            await task;
        }
        catch
        {
        }
    }
}
