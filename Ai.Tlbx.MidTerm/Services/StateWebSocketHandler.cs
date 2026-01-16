using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class StateWebSocketHandler
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly UpdateService _updateService;
    private readonly SettingsService _settingsService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;

    public StateWebSocketHandler(
        TtyHostSessionManager sessionManager,
        UpdateService updateService,
        SettingsService settingsService,
        AuthService authService,
        ShutdownService shutdownService)
    {
        _sessionManager = sessionManager;
        _updateService = updateService;
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

                var sessionList = _sessionManager.GetSessionList();
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

        var sessionListenerId = _sessionManager.AddStateListener(OnStateChange);
        var updateListenerId = _updateService.AddUpdateListener(OnUpdateAvailable);
        var shutdownToken = _shutdownService.Token;

        try
        {
            lastUpdate = _updateService.LatestUpdate;
            await SendStateAsync();

            var buffer = new byte[1024];
            while (ws.State == WebSocketState.Open && !shutdownToken.IsCancellationRequested)
            {
                try
                {
                    var result = await ws.ReceiveAsync(buffer, shutdownToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    break;
                }
            }
        }
        finally
        {
            _sessionManager.RemoveStateListener(sessionListenerId);
            _updateService.RemoveUpdateListener(updateListenerId);
            sendLock.Dispose();

            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, cts.Token);
                }
                catch
                {
                }
            }
        }
    }
}
