using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.WebSockets;

public sealed class LensWebSocketHandler
{
    private readonly TtyHostSessionManager _sessionManager;
    private readonly SessionSupervisorService _sessionSupervisor;
    private readonly SessionLensRuntimeService _lensRuntime;
    private readonly SessionCodexHandoffService _codexHandoff;
    private readonly AiCliProfileService _aiCliProfileService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;

    public LensWebSocketHandler(
        TtyHostSessionManager sessionManager,
        SessionSupervisorService sessionSupervisor,
        SessionLensRuntimeService lensRuntime,
        SessionCodexHandoffService codexHandoff,
        AiCliProfileService aiCliProfileService,
        AuthService authService,
        ShutdownService shutdownService)
    {
        _sessionManager = sessionManager;
        _sessionSupervisor = sessionSupervisor;
        _lensRuntime = lensRuntime;
        _codexHandoff = codexHandoff;
        _aiCliProfileService = aiCliProfileService;
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

        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var sendLock = new SemaphoreSlim(1, 1);
        var subscriptions = new Dictionary<string, LensSocketSubscription>(StringComparer.Ordinal);
        var shutdownToken = _shutdownService.Token;

        async Task SendJsonAsync<T>(T payload, JsonTypeInfo<T> typeInfo)
        {
            if (ws.State != WebSocketState.Open)
            {
                return;
            }

            await sendLock.WaitAsync(shutdownToken).ConfigureAwait(false);
            try
            {
                if (ws.State != WebSocketState.Open)
                {
                    return;
                }

                var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, typeInfo);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, shutdownToken).ConfigureAwait(false);
            }
            catch (WebSocketException) { }
            catch (ObjectDisposedException) { }
            catch (Exception ex)
            {
                Log.Verbose(() => $"[LensWS] SendJsonAsync failed: {ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                sendLock.Release();
            }
        }

        async Task SendErrorAsync(string? id, string? action, string? sessionId, string message)
        {
            await SendJsonAsync(
                new LensWsErrorMessage
                {
                    Id = id,
                    Action = action,
                    SessionId = sessionId,
                    Message = message
                },
                AppJsonContext.Default.LensWsErrorMessage).ConfigureAwait(false);
        }

        async Task RemoveSubscriptionAsync(string sessionId)
        {
            if (subscriptions.Remove(sessionId, out var existing))
            {
                existing.Dispose();
            }

            await SendJsonAsync(
                new LensWsAckMessage
                {
                    Id = $"unsubscribe:{sessionId}",
                    Action = "unsubscribe",
                    SessionId = sessionId
                },
                AppJsonContext.Default.LensWsAckMessage).ConfigureAwait(false);
        }

        async Task ReplaceSubscriptionAsync(
            string sessionId,
            long afterSequence,
            LensHistoryWindowRequest? historyWindow)
        {
            if (subscriptions.Remove(sessionId, out var existing))
            {
                existing.Dispose();
            }

            var requestedWindow = historyWindow is null
                ? null
                : new LensHistoryWindowRequest
                {
                    StartIndex = historyWindow.StartIndex,
                    Count = historyWindow.Count
                };

            var currentHistoryWindow = await _lensRuntime.GetHistoryWindowAsync(
                sessionId,
                requestedWindow?.StartIndex,
                requestedWindow?.Count,
                shutdownToken).ConfigureAwait(false);

            var state = LensSocketSubscription.Create(_lensRuntime, sessionId, shutdownToken);
            var cancellation = state.Cancellation;
            var subscription = state.Subscription;
            subscriptions[sessionId] = state;
            state.ReaderTask = Task.Run(async () =>
            {
                try
                {
                    await foreach (var patch in subscription.Reader.ReadAllAsync(cancellation.Token).ConfigureAwait(false))
                    {
                        await SendJsonAsync(
                            new LensWsHistoryPatchMessage
                            {
                                SessionId = sessionId,
                                Patch = patch
                            },
                            AppJsonContext.Default.LensWsHistoryPatchMessage).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex)
                {
                    Log.Verbose(() => $"[LensWS] Stream subscription failed for {sessionId}: {ex.Message}");
                }
            }, CancellationToken.None);

            if (currentHistoryWindow is not null)
            {
                afterSequence = Math.Max(afterSequence, currentHistoryWindow.LatestSequence);
                await SendJsonAsync(
                    new LensWsHistoryWindowMessage
                    {
                        SessionId = sessionId,
                        HistoryWindow = currentHistoryWindow
                    },
                    AppJsonContext.Default.LensWsHistoryWindowMessage).ConfigureAwait(false);
            }

            await SendJsonAsync(
                new LensWsAckMessage
                {
                    Id = $"subscribe:{sessionId}",
                    Action = "subscribe",
                    SessionId = sessionId
                },
                AppJsonContext.Default.LensWsAckMessage).ConfigureAwait(false);
        }

        try
        {
            var buffer = new byte[8192];
            var messageBuffer = new List<byte>();

            while (ws.State == WebSocketState.Open && !shutdownToken.IsCancellationRequested)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await ws.ReceiveAsync(buffer, shutdownToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    continue;
                }

                messageBuffer.AddRange(buffer.AsSpan(0, result.Count).ToArray());
                if (!result.EndOfMessage)
                {
                    continue;
                }

                var json = Encoding.UTF8.GetString(messageBuffer.ToArray());
                messageBuffer.Clear();

                try
                {
                    using var document = JsonDocument.Parse(json);
                    var root = document.RootElement;
                    var type = root.TryGetProperty("type", out var typeProperty)
                        ? typeProperty.GetString()
                        : null;

                    switch (type)
                    {
                        case "subscribe":
                        {
                            var message = JsonSerializer.Deserialize(root.GetRawText(), AppJsonContext.Default.LensWsSubscriptionMessage);
                            if (message is null || string.IsNullOrWhiteSpace(message.SessionId))
                            {
                                continue;
                            }

                            await ReplaceSubscriptionAsync(
                                message.SessionId,
                                Math.Max(0, message.AfterSequence),
                                message.HistoryWindow).ConfigureAwait(false);
                            continue;
                        }
                        case "unsubscribe":
                        {
                            var message = JsonSerializer.Deserialize(root.GetRawText(), AppJsonContext.Default.LensWsSubscriptionMessage);
                            if (message is null || string.IsNullOrWhiteSpace(message.SessionId))
                            {
                                continue;
                            }

                            await RemoveSubscriptionAsync(message.SessionId).ConfigureAwait(false);
                            continue;
                        }
                        case "request":
                        {
                            var request = JsonSerializer.Deserialize(root.GetRawText(), AppJsonContext.Default.LensWsRequestMessage);
                            if (request is null)
                            {
                                continue;
                            }

                            await HandleRequestAsync(
                                request,
                                SendJsonAsync,
                                SendJsonAsync,
                                SendJsonAsync,
                                SendJsonAsync,
                                SendErrorAsync).ConfigureAwait(false);
                            continue;
                        }
                    }
                }
                catch (JsonException ex)
                {
                    Log.Verbose(() => $"[LensWS] Failed to parse client message: {ex.Message}");
                }
            }
        }
        finally
        {
            foreach (var subscription in subscriptions.Values)
            {
                subscription.Dispose();
            }

            subscriptions.Clear();
            sendLock.Dispose();

            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    var closeCode = shutdownToken.IsCancellationRequested
                        ? (WebSocketCloseStatus)MuxProtocol.CloseServerShutdown
                        : WebSocketCloseStatus.NormalClosure;
                    await ws.CloseAsync(closeCode, shutdownToken.IsCancellationRequested ? "Server shutting down" : null, cts.Token).ConfigureAwait(false);
                }
                catch
                {
                }
            }
        }
    }

    private async Task HandleRequestAsync(
        LensWsRequestMessage request,
        Func<LensWsAckMessage, JsonTypeInfo<LensWsAckMessage>, Task> sendAck,
        Func<LensWsHistoryWindowMessage, JsonTypeInfo<LensWsHistoryWindowMessage>, Task> sendHistoryWindow,
        Func<LensWsTurnStartedMessage, JsonTypeInfo<LensWsTurnStartedMessage>, Task> sendTurnStarted,
        Func<LensWsCommandAcceptedMessage, JsonTypeInfo<LensWsCommandAcceptedMessage>, Task> sendCommandAccepted,
        Func<string?, string?, string?, string, Task> sendError)
    {
        if (string.IsNullOrWhiteSpace(request.SessionId) || _sessionManager.GetSession(request.SessionId) is null)
        {
            await sendError(request.Id, request.Action, request.SessionId, "Lens session was not found.").ConfigureAwait(false);
            return;
        }

        try
        {
            switch (request.Action)
            {
                case "attach":
                    await EnsureLensAttachedAsync(request.SessionId, CancellationToken.None).ConfigureAwait(false);
                    await sendAck(
                        new LensWsAckMessage
                        {
                            Id = request.Id,
                            Action = request.Action,
                            SessionId = request.SessionId
                        },
                        AppJsonContext.Default.LensWsAckMessage).ConfigureAwait(false);
                    break;

                case "detach":
                    await DetachLensAsync(request.SessionId, CancellationToken.None).ConfigureAwait(false);
                    await sendAck(
                        new LensWsAckMessage
                        {
                            Id = request.Id,
                            Action = request.Action,
                            SessionId = request.SessionId
                        },
                        AppJsonContext.Default.LensWsAckMessage).ConfigureAwait(false);
                    break;

                case "history.window.get":
                {
                    var historyWindow = await _lensRuntime.GetHistoryWindowAsync(
                        request.SessionId,
                        request.HistoryWindow?.StartIndex,
                        request.HistoryWindow?.Count,
                        CancellationToken.None).ConfigureAwait(false);
                    if (historyWindow is null)
                    {
                        await sendError(request.Id, request.Action, request.SessionId, "Lens history window is not available.").ConfigureAwait(false);
                        return;
                    }

                    await sendHistoryWindow(
                        new LensWsHistoryWindowMessage
                        {
                            Id = request.Id,
                            SessionId = request.SessionId,
                            HistoryWindow = historyWindow
                        },
                        AppJsonContext.Default.LensWsHistoryWindowMessage).ConfigureAwait(false);
                    break;
                }

                case "turn.submit":
                {
                    var session = await EnsureLensAttachedAsync(request.SessionId, CancellationToken.None).ConfigureAwait(false);
                    var response = await _lensRuntime.StartTurnAsync(
                        request.SessionId,
                        request.Turn ?? new LensTurnRequest(),
                        CancellationToken.None).ConfigureAwait(false);
                    await sendTurnStarted(
                        new LensWsTurnStartedMessage
                        {
                            Id = request.Id,
                            SessionId = session.Id,
                            Response = response
                        },
                        AppJsonContext.Default.LensWsTurnStartedMessage).ConfigureAwait(false);
                    break;
                }

                case "turn.interrupt":
                {
                    var response = await _lensRuntime.InterruptTurnAsync(
                        request.SessionId,
                        request.Interrupt ?? new LensInterruptRequest(),
                        CancellationToken.None).ConfigureAwait(false);
                    await sendCommandAccepted(
                        new LensWsCommandAcceptedMessage
                        {
                            Id = request.Id,
                            SessionId = request.SessionId,
                            Response = response
                        },
                        AppJsonContext.Default.LensWsCommandAcceptedMessage).ConfigureAwait(false);
                    break;
                }

                case "request.approve":
                {
                    var response = await _lensRuntime.ResolveRequestAsync(
                        request.SessionId,
                        request.RequestId ?? string.Empty,
                        new LensRequestDecisionRequest { Decision = "accept" },
                        CancellationToken.None).ConfigureAwait(false);
                    await sendCommandAccepted(
                        new LensWsCommandAcceptedMessage
                        {
                            Id = request.Id,
                            SessionId = request.SessionId,
                            Response = response
                        },
                        AppJsonContext.Default.LensWsCommandAcceptedMessage).ConfigureAwait(false);
                    break;
                }

                case "request.decline":
                case "request.resolve":
                {
                    var decision = request.RequestDecision ?? new LensRequestDecisionRequest
                    {
                        Decision = request.Action == "request.decline" ? "decline" : "accept"
                    };
                    if (request.Action == "request.decline" && string.IsNullOrWhiteSpace(decision.Decision))
                    {
                        decision.Decision = "decline";
                    }

                    var response = await _lensRuntime.ResolveRequestAsync(
                        request.SessionId,
                        request.RequestId ?? string.Empty,
                        decision,
                        CancellationToken.None).ConfigureAwait(false);
                    await sendCommandAccepted(
                        new LensWsCommandAcceptedMessage
                        {
                            Id = request.Id,
                            SessionId = request.SessionId,
                            Response = response
                        },
                        AppJsonContext.Default.LensWsCommandAcceptedMessage).ConfigureAwait(false);
                    break;
                }

                case "userInput.resolve":
                {
                    var response = await _lensRuntime.ResolveUserInputAsync(
                        request.SessionId,
                        request.RequestId ?? string.Empty,
                        request.UserInputAnswer ?? new LensUserInputAnswerRequest(),
                        CancellationToken.None).ConfigureAwait(false);
                    await sendCommandAccepted(
                        new LensWsCommandAcceptedMessage
                        {
                            Id = request.Id,
                            SessionId = request.SessionId,
                            Response = response
                        },
                        AppJsonContext.Default.LensWsCommandAcceptedMessage).ConfigureAwait(false);
                    break;
                }

                default:
                    await sendError(request.Id, request.Action, request.SessionId, $"Unknown Lens action '{request.Action}'.").ConfigureAwait(false);
                    break;
            }
        }
        catch (InvalidOperationException ex)
        {
            await sendError(request.Id, request.Action, request.SessionId, ex.Message).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Lens WebSocket request '{request.Action}' failed for {request.SessionId}: {ex.Message}");
            await sendError(request.Id, request.Action, request.SessionId, ex.Message).ConfigureAwait(false);
        }
    }

    private async Task<SessionInfoDto> EnsureLensAttachedAsync(string sessionId, CancellationToken ct)
    {
        var session = GetSessionDto(sessionId);
        var resumeThreadId = session.LensResumeThreadId;
        if (!session.LensOnly &&
            _aiCliProfileService.NormalizeProfile(null, session) == AiCliProfileService.CodexProfile)
        {
            resumeThreadId = await _codexHandoff.PrepareForLensAsync(session, ct).ConfigureAwait(false);
        }

        var attached = await _lensRuntime.EnsureAttachedAsync(sessionId, session, resumeThreadId, ct).ConfigureAwait(false);
        if (!attached && !_lensRuntime.HasHistory(sessionId))
        {
            throw new InvalidOperationException("Lens native runtime is not available for this session.");
        }

        return session;
    }

    private async Task DetachLensAsync(string sessionId, CancellationToken ct)
    {
        var session = GetSessionDto(sessionId);
        if (session.LensOnly ||
            _aiCliProfileService.NormalizeProfile(null, session) != AiCliProfileService.CodexProfile)
        {
            await _lensRuntime.DetachAsync(sessionId, ct).ConfigureAwait(false);
            return;
        }

        await _codexHandoff.RestoreTerminalAsync(session, ct).ConfigureAwait(false);
    }

    private SessionInfoDto GetSessionDto(string sessionId)
    {
        var session = _sessionManager.GetSessionList().Sessions.FirstOrDefault(s => string.Equals(s.Id, sessionId, StringComparison.Ordinal))
                      ?? throw new InvalidOperationException("Lens session was not found.");
        session.Supervisor = _sessionSupervisor.Describe(session);
        session.HasLensHistory = _lensRuntime.HasHistory(session.Id);
        return session;
    }

    private sealed class LensSocketSubscription : IDisposable
    {
        private LensSocketSubscription(LensHistoryPatchSubscription subscription, CancellationTokenSource cancellation)
        {
            Subscription = subscription;
            Cancellation = cancellation;
        }

        public static LensSocketSubscription Create(
            SessionLensRuntimeService lensRuntime,
            string sessionId,
            CancellationToken shutdownToken)
        {
            var cancellation = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            var subscription = lensRuntime.SubscribeHistoryPatches(sessionId, cancellation.Token);
            return new LensSocketSubscription(subscription, cancellation);
        }

        public LensHistoryPatchSubscription Subscription { get; }
        public CancellationTokenSource Cancellation { get; }
        public Task? ReaderTask { get; set; }

        public void Dispose()
        {
            Cancellation.Cancel();
            Subscription.Dispose();
            Cancellation.Dispose();
        }
    }
}
