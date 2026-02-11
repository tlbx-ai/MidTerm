using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services.Tmux;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

public sealed class StateWebSocketHandler
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly UpdateService _updateService;
    private readonly SettingsService _settingsService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;
    private readonly MainBrowserService _mainBrowserService;
    private readonly TmuxLayoutBridge? _tmuxLayoutBridge;

    public StateWebSocketHandler(
        TtyHostSessionManager sessionManager,
        UpdateService updateService,
        SettingsService settingsService,
        AuthService authService,
        ShutdownService shutdownService,
        MainBrowserService mainBrowserService,
        TmuxLayoutBridge? tmuxLayoutBridge = null)
    {
        _sessionManager = sessionManager;
        _updateService = updateService;
        _settingsService = settingsService;
        _authService = authService;
        _shutdownService = shutdownService;
        _mainBrowserService = mainBrowserService;
        _tmuxLayoutBridge = tmuxLayoutBridge;
    }

    public async Task HandleAsync(HttpContext context)
    {
        // SECURITY: Validate auth before accepting WebSocket
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

        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var sendLock = new SemaphoreSlim(1, 1);
        UpdateInfo? lastUpdate = null;

        async Task SendJsonAsync<T>(T payload, JsonTypeInfo<T> typeInfo)
        {
            if (ws.State != WebSocketState.Open) return;
            await sendLock.WaitAsync();
            try
            {
                if (ws.State != WebSocketState.Open) return;
                var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, typeInfo);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (WebSocketException) { }
            catch (ObjectDisposedException) { }
            catch (Exception ex)
            {
                Log.Verbose(() => $"[StateWS] SendJsonAsync failed: {ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                sendLock.Release();
            }
        }

        async Task SendStateAsync()
        {
            var sessionList = _sessionManager.GetSessionList();
            var state = new StateUpdate
            {
                Sessions = sessionList,
                Update = lastUpdate
            };
            await SendJsonAsync(state, AppJsonContext.Default.StateUpdate);
        }

        async Task SendCommandResponseAsync(string id, bool success, object? data = null, string? error = null)
        {
            var response = new WsCommandResponse
            {
                Type = "response",
                Id = id,
                Success = success,
                Data = data,
                Error = error
            };
            await SendJsonAsync(response, AppJsonContext.Default.WsCommandResponse);
        }

        async Task SendStateWithRetryAsync()
        {
            for (var attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    await SendStateAsync();
                    return;
                }
                catch (WebSocketException) when (attempt < 2)
                {
                    await Task.Delay(100);
                }
                catch (Exception ex)
                {
                    Log.Verbose(() => $"[StateWS] SendStateWithRetry failed: {ex.GetType().Name}: {ex.Message}");
                    return;
                }
            }
        }

        void OnStateChange()
        {
            _ = SendStateWithRetryAsync();
        }

        void OnUpdateAvailable(UpdateInfo update)
        {
            lastUpdate = update;
            _ = SendStateWithRetryAsync();
        }

        var connectionToken = new object();
        var clientId = context.Request.Query["clientId"].FirstOrDefault();

        async Task SendMainBrowserStatusAsync()
        {
            var status = new MainBrowserStatusMessage
            {
                IsMain = _mainBrowserService.IsMain(connectionToken),
                ShowButton = _mainBrowserService.HasMultipleClients
            };
            await SendJsonAsync(status, AppJsonContext.Default.MainBrowserStatusMessage);
        }

        void OnMainBrowserChanged()
        {
            _ = SendMainBrowserStatusAsync();
        }

        var sessionListenerId = _sessionManager.AddStateListener(OnStateChange);
        var updateListenerId = _updateService.AddUpdateListener(OnUpdateAvailable);
        var shutdownToken = _shutdownService.Token;

        void OnDockRequested(string newSessionId, string relativeToSessionId, string position)
        {
            var instruction = new TmuxDockInstruction
            {
                NewSessionId = newSessionId,
                RelativeToSessionId = relativeToSessionId,
                Position = position
            };
            _ = SendJsonAsync(instruction, TmuxJsonContext.Default.TmuxDockInstruction);
        }

        void OnFocusRequested(string sessionId)
        {
            var instruction = new TmuxFocusInstruction { SessionId = sessionId };
            _ = SendJsonAsync(instruction, TmuxJsonContext.Default.TmuxFocusInstruction);
        }

        void OnSwapRequested(string sessionIdA, string sessionIdB)
        {
            var instruction = new TmuxSwapInstruction { SessionIdA = sessionIdA, SessionIdB = sessionIdB };
            _ = SendJsonAsync(instruction, TmuxJsonContext.Default.TmuxSwapInstruction);
        }

        if (_tmuxLayoutBridge is not null)
        {
            _tmuxLayoutBridge.OnDockRequested += OnDockRequested;
            _tmuxLayoutBridge.OnFocusRequested += OnFocusRequested;
            _tmuxLayoutBridge.OnSwapRequested += OnSwapRequested;
        }

        try
        {
            lastUpdate = _updateService.LatestUpdate;
            await SendStateAsync();
            _mainBrowserService.OnMainBrowserChanged += OnMainBrowserChanged;
            _mainBrowserService.Register(connectionToken, clientId);
            await SendMainBrowserStatusAsync();

            var buffer = new byte[8192];
            var messageBuffer = new List<byte>();

            while (ws.State == WebSocketState.Open && !shutdownToken.IsCancellationRequested)
            {
                try
                {
                    var result = await ws.ReceiveAsync(buffer, shutdownToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var existingLen = messageBuffer.Count;
                        CollectionsMarshal.SetCount(messageBuffer, existingLen + result.Count);
                        buffer.AsSpan(0, result.Count).CopyTo(
                            CollectionsMarshal.AsSpan(messageBuffer).Slice(existingLen));

                        if (result.EndOfMessage)
                        {
                            var messageJson = Encoding.UTF8.GetString(CollectionsMarshal.AsSpan(messageBuffer));
                            messageBuffer.Clear();

                            await HandleCommandAsync(messageJson, SendCommandResponseAsync, connectionToken);
                        }
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
            _mainBrowserService.OnMainBrowserChanged -= OnMainBrowserChanged;
            _mainBrowserService.Unregister(connectionToken);

            if (_tmuxLayoutBridge is not null)
            {
                _tmuxLayoutBridge.OnDockRequested -= OnDockRequested;
                _tmuxLayoutBridge.OnFocusRequested -= OnFocusRequested;
                _tmuxLayoutBridge.OnSwapRequested -= OnSwapRequested;
            }

            sendLock.Dispose();

            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    var closeCode = shutdownToken.IsCancellationRequested
                        ? (WebSocketCloseStatus)MuxProtocol.CloseServerShutdown
                        : WebSocketCloseStatus.NormalClosure;
                    var closeMessage = shutdownToken.IsCancellationRequested
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

    private async Task HandleCommandAsync(string json, Func<string, bool, object?, string?, Task> sendResponse, object connectionToken)
    {
        WsCommand? cmd;
        try
        {
            cmd = JsonSerializer.Deserialize(json, AppJsonContext.Default.WsCommand);
        }
        catch
        {
            return;
        }

        if (cmd is null || cmd.Type != "command" || string.IsNullOrEmpty(cmd.Id))
        {
            return;
        }

        try
        {
            switch (cmd.Action)
            {
                case "session.create":
                    await HandleSessionCreateAsync(cmd, sendResponse);
                    break;

                case "session.close":
                    await HandleSessionCloseAsync(cmd, sendResponse);
                    break;

                case "session.rename":
                    await HandleSessionRenameAsync(cmd, sendResponse);
                    break;

                case "session.reorder":
                    await HandleSessionReorderAsync(cmd, sendResponse);
                    break;

                case "settings.save":
                    await HandleSettingsSaveAsync(cmd, sendResponse);
                    break;

                case "browser.claimMain":
                    _mainBrowserService.Claim(connectionToken);
                    await sendResponse(cmd.Id, true, null, null);
                    break;

                case "browser.releaseMain":
                    _mainBrowserService.Release(connectionToken);
                    await sendResponse(cmd.Id, true, null, null);
                    break;

                default:
                    await sendResponse(cmd.Id, false, null, $"Unknown action: {cmd.Action}");
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"Command handler error for {cmd.Action}: {ex.Message}");
            await sendResponse(cmd.Id, false, null, ex.Message);
        }
    }

    private async Task HandleSessionCreateAsync(WsCommand cmd, Func<string, bool, object?, string?, Task> sendResponse)
    {
        var payload = cmd.Payload;
        var cols = payload?.Cols ?? 80;
        var rows = payload?.Rows ?? 24;
        var workingDir = payload?.WorkingDirectory;

        var session = await _sessionManager.CreateSessionAsync(payload?.Shell, cols, rows, workingDir);

        if (session is null)
        {
            await sendResponse(cmd.Id, false, null, "Failed to create session");
            return;
        }

        var data = new WsSessionCreatedData
        {
            Id = session.Id,
            Pid = session.Pid,
            ShellType = session.ShellType
        };

        await sendResponse(cmd.Id, true, data, null);
    }

    private async Task HandleSessionCloseAsync(WsCommand cmd, Func<string, bool, object?, string?, Task> sendResponse)
    {
        var sessionId = cmd.Payload?.SessionId;
        if (string.IsNullOrEmpty(sessionId))
        {
            await sendResponse(cmd.Id, false, null, "sessionId required");
            return;
        }

        var closed = await _sessionManager.CloseSessionAsync(sessionId);
        await sendResponse(cmd.Id, closed, null, closed ? null : "Session not found");
    }

    private async Task HandleSessionRenameAsync(WsCommand cmd, Func<string, bool, object?, string?, Task> sendResponse)
    {
        var sessionId = cmd.Payload?.SessionId;
        if (string.IsNullOrEmpty(sessionId))
        {
            await sendResponse(cmd.Id, false, null, "sessionId required");
            return;
        }

        var name = cmd.Payload?.Name;
        var isManual = cmd.Payload?.Auto != true;
        var renamed = await _sessionManager.SetSessionNameAsync(sessionId, name, isManual);
        await sendResponse(cmd.Id, renamed, null, renamed ? null : "Session not found");
    }

    private async Task HandleSessionReorderAsync(WsCommand cmd, Func<string, bool, object?, string?, Task> sendResponse)
    {
        var sessionIds = cmd.Payload?.SessionIds;
        if (sessionIds is null || sessionIds.Count == 0)
        {
            await sendResponse(cmd.Id, false, null, "sessionIds required");
            return;
        }

        var reordered = _sessionManager.ReorderSessions(sessionIds);
        await sendResponse(cmd.Id, reordered, null, reordered ? null : "Invalid session IDs");
    }

    private async Task HandleSettingsSaveAsync(WsCommand cmd, Func<string, bool, object?, string?, Task> sendResponse)
    {
        var publicSettings = cmd.Payload?.Settings;
        if (publicSettings is null)
        {
            await sendResponse(cmd.Id, false, null, "settings required");
            return;
        }

        try
        {
            var currentSettings = _settingsService.Load();
            publicSettings.ApplyTo(currentSettings);
            _settingsService.Save(currentSettings);
            await sendResponse(cmd.Id, true, null, null);
        }
        catch (ArgumentException ex)
        {
            await sendResponse(cmd.Id, false, null, ex.Message);
        }
    }
}
