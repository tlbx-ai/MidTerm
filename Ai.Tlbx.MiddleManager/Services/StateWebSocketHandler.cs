using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Ai.Tlbx.MiddleManager.Services;

public sealed class StateWebSocketHandler
{
    private readonly ConHostSessionManager? _conHostManager;
    private readonly SessionManager? _directManager;
    private readonly UpdateService _updateService;

    public StateWebSocketHandler(
        ConHostSessionManager? conHostManager,
        SessionManager? directManager,
        UpdateService updateService)
    {
        _conHostManager = conHostManager;
        _directManager = directManager;
        _updateService = updateService;
    }

    public async Task HandleAsync(HttpContext context)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var sendLock = new SemaphoreSlim(1, 1);
        UpdateInfo? lastUpdate = null;

        async Task SendStateAsync()
        {
            if (ws.State != WebSocketState.Open)
            {
                return;
            }

            await sendLock.WaitAsync();
            try
            {
                if (ws.State != WebSocketState.Open)
                {
                    return;
                }

                var sessionList = _conHostManager?.GetSessionList() ?? _directManager!.GetSessionList();
                var state = new StateUpdate
                {
                    Sessions = sessionList,
                    Update = lastUpdate
                };
                var json = JsonSerializer.Serialize(state, AppJsonContext.Default.StateUpdate);
                var bytes = Encoding.UTF8.GetBytes(json);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch
            {
            }
            finally
            {
                sendLock.Release();
            }
        }

        void OnStateChange() => _ = SendStateAsync();

        void OnUpdateAvailable(UpdateInfo update)
        {
            lastUpdate = update;
            _ = SendStateAsync();
        }

        string sessionListenerId;
        if (_conHostManager is not null)
        {
            sessionListenerId = _conHostManager.AddStateListener(OnStateChange);
        }
        else
        {
            sessionListenerId = _directManager!.AddStateListener(OnStateChange);
        }
        var updateListenerId = _updateService.AddUpdateListener(OnUpdateAvailable);

        try
        {
            lastUpdate = _updateService.LatestUpdate;
            await SendStateAsync();

            var buffer = new byte[1024];
            while (ws.State == WebSocketState.Open)
            {
                try
                {
                    var result = await ws.ReceiveAsync(buffer, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }
                }
                catch
                {
                    break;
                }
            }
        }
        finally
        {
            if (_conHostManager is not null)
            {
                _conHostManager.RemoveStateListener(sessionListenerId);
            }
            else
            {
                _directManager!.RemoveStateListener(sessionListenerId);
            }
            _updateService.RemoveUpdateListener(updateListenerId);
            sendLock.Dispose();

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
}
