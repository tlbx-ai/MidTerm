using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.Browser;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserWebSocketHandler
{
    private readonly BrowserCommandService _commandService;
    private readonly BrowserPreviewRegistry _previewRegistry;
    private readonly SettingsService _settingsService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;

    public BrowserWebSocketHandler(
        BrowserCommandService commandService,
        BrowserPreviewRegistry previewRegistry,
        SettingsService settingsService,
        AuthService authService,
        ShutdownService shutdownService)
    {
        _commandService = commandService;
        _previewRegistry = previewRegistry;
        _settingsService = settingsService;
        _authService = authService;
        _shutdownService = shutdownService;
    }

    public async Task HandleAsync(HttpContext context)
    {
        var queryPreviewId = context.Request.Query["previewId"].FirstOrDefault();
        var queryPreviewToken = context.Request.Query["token"].FirstOrDefault();
        var hasPreviewAuth = _previewRegistry.TryValidate(queryPreviewId, queryPreviewToken, out var previewClient);

        if (!hasPreviewAuth)
        {
            var settings = _settingsService.Load();
            if (settings.AuthenticationEnabled && !string.IsNullOrEmpty(settings.PasswordHash))
            {
                var token = context.Request.Cookies[AuthService.SessionCookieName];
                if (token is null || !_authService.ValidateSessionToken(token))
                {
                    context.Response.StatusCode = 401;
                    return;
                }
            }
        }

        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var sendLock = new SemaphoreSlim(1, 1);
        var shutdownToken = _shutdownService.Token;
        var connectionId = Guid.NewGuid().ToString("N");
        var sessionId = previewClient?.SessionId ?? context.Request.Query["sessionId"].FirstOrDefault();
        var previewId = previewClient?.PreviewId ?? queryPreviewId;

        _commandService.RegisterClient(connectionId, sessionId, previewId, OnCommandReady);
        BrowserLog.Info("Browser WebSocket connected");

        async Task SendCommandAsync(BrowserWsMessage message)
        {
            if (ws.State != WebSocketState.Open)
                return;

            await sendLock.WaitAsync();
            try
            {
                if (ws.State != WebSocketState.Open)
                    return;

                var bytes = JsonSerializer.SerializeToUtf8Bytes(message, AppJsonContext.Default.BrowserWsMessage);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception ex)
            {
                BrowserLog.Error($"SendCommand failed: {ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                sendLock.Release();
            }
        }

        void OnCommandReady(BrowserWsMessage msg) => _ = SendCommandAsync(msg);

        try
        {
            var buffer = new byte[65536];
            var messageBuffer = new List<byte>();

            while (ws.State == WebSocketState.Open && !shutdownToken.IsCancellationRequested)
            {
                try
                {
                    var result = await ws.ReceiveAsync(buffer, shutdownToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                        break;

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var existingLen = messageBuffer.Count;
                        CollectionsMarshal.SetCount(messageBuffer, existingLen + result.Count);
                        buffer.AsSpan(0, result.Count).CopyTo(
                            CollectionsMarshal.AsSpan(messageBuffer).Slice(existingLen));

                        if (result.EndOfMessage)
                        {
                            var json = Encoding.UTF8.GetString(CollectionsMarshal.AsSpan(messageBuffer));
                            messageBuffer.Clear();

                            try
                            {
                                var wsResult = JsonSerializer.Deserialize(json, AppJsonContext.Default.BrowserWsResult);
                                if (wsResult is not null)
                                {
                                    _commandService.ReceiveResult(wsResult);
                                }
                            }
                            catch (JsonException ex)
                            {
                                BrowserLog.Error($"Failed to parse browser result: {ex.Message}");
                            }
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (WebSocketException)
                {
                    break;
                }
            }
        }
        finally
        {
            _commandService.UnregisterClient(connectionId);
            sendLock.Dispose();
            BrowserLog.Info("Browser WebSocket disconnected");

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
