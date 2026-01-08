using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Handles WebSocket connections for log streaming.
/// </summary>
public sealed class LogWebSocketHandler : IDisposable
{
    private const int SendTimeoutMs = 5000;
    private const int ReceiveTimeoutMs = 60000;
    private static readonly byte[] PingMessage = "{\"messageType\":\"ping\"}"u8.ToArray();

    private readonly LogFileWatcher _fileWatcher;
    private readonly TtyHostSessionManager _sessionManager;
    private readonly ConcurrentDictionary<string, LogClient> _clients = new();
    private readonly string _subscriptionId;
    private bool _disposed;

    public LogWebSocketHandler(LogFileWatcher fileWatcher, TtyHostSessionManager sessionManager)
    {
        _fileWatcher = fileWatcher;
        _sessionManager = sessionManager;

        _subscriptionId = _fileWatcher.Subscribe(BroadcastLogEntry);
    }

    public async Task HandleAsync(HttpContext context)
    {
        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N");
        var client = new LogClient(clientId, ws);
        _clients[clientId] = client;

        Log.Info(() => $"[LogWS] Client {clientId} connected");

        try
        {
            await ProcessMessagesAsync(client, context.RequestAborted);
        }
        finally
        {
            _clients.TryRemove(clientId, out _);
            client.Dispose();
            Log.Info(() => $"[LogWS] Client {clientId} disconnected");
        }
    }

    private async Task ProcessMessagesAsync(LogClient client, CancellationToken requestAborted)
    {
        var buffer = new byte[4096];

        while (client.IsOpen && !requestAborted.IsCancellationRequested)
        {
            WebSocketReceiveResult result;
            try
            {
                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
                timeoutCts.CancelAfter(ReceiveTimeoutMs);

                result = await client.ReceiveAsync(buffer, timeoutCts.Token);
            }
            catch (OperationCanceledException) when (!requestAborted.IsCancellationRequested)
            {
                // Receive timeout - send ping to check if client is alive
                if (!await client.TrySendAsync(PingMessage, SendTimeoutMs))
                {
                    break;
                }
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

            if (result.MessageType == WebSocketMessageType.Text)
            {
                var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
                await HandleMessageAsync(client, json);
            }
        }
    }

    private async Task HandleMessageAsync(LogClient client, string json)
    {
        try
        {
            var message = JsonSerializer.Deserialize(json, AppJsonContext.Default.LogSubscribeMessage);
            if (message is null) return;

            switch (message.Action)
            {
                case "subscribe":
                    HandleSubscribe(client, message);
                    break;

                case "unsubscribe":
                    HandleUnsubscribe(client, message);
                    break;

                case "history":
                    await SendHistoryAsync(client, message);
                    break;

                case "sessions":
                    await SendSessionsAsync(client);
                    break;
            }
        }
        catch (JsonException ex)
        {
            Log.Warn(() => $"[LogWS] Invalid message from {client.Id}: {ex.Message}");
        }
    }

    private void HandleSubscribe(LogClient client, LogSubscribeMessage message)
    {
        if (message.Type == "mt")
        {
            client.SubscribedToMt = true;
            Log.Verbose(() => $"[LogWS] Client {client.Id} subscribed to mt logs");
        }
        else if (message.Type == "mthost" && message.SessionId is not null)
        {
            client.AddSubscribedSession(message.SessionId);
            Log.Verbose(() => $"[LogWS] Client {client.Id} subscribed to session {message.SessionId}");
        }
    }

    private void HandleUnsubscribe(LogClient client, LogSubscribeMessage message)
    {
        if (message.Type == "mt")
        {
            client.SubscribedToMt = false;
        }
        else if (message.Type == "mthost" && message.SessionId is not null)
        {
            client.RemoveSubscribedSession(message.SessionId);
        }
    }

    private async Task SendHistoryAsync(LogClient client, LogSubscribeMessage message)
    {
        var limit = message.Limit ?? 100;
        var entries = _fileWatcher.GetRecentEntries(message.Type, message.SessionId, limit);

        var historyMessage = new LogHistoryMessage
        {
            MessageType = "history",
            Source = message.Type,
            SessionId = message.SessionId,
            Entries = entries,
            HasMore = entries.Count >= limit
        };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(historyMessage, AppJsonContext.Default.LogHistoryMessage);
        await client.TrySendAsync(bytes, SendTimeoutMs);
    }

    private async Task SendSessionsAsync(LogClient client)
    {
        var activeSessions = _sessionManager.GetAllSessions().Select(s => s.Id).ToList();
        var sessions = _fileWatcher.GetLogSessions(activeSessions);

        var sessionsMessage = new LogSessionsMessage
        {
            MessageType = "sessions",
            Sessions = sessions
        };

        var bytes = JsonSerializer.SerializeToUtf8Bytes(sessionsMessage, AppJsonContext.Default.LogSessionsMessage);
        await client.TrySendAsync(bytes, SendTimeoutMs);
    }

    private void BroadcastLogEntry(LogEntryMessage entry)
    {
        // Serialize once for all clients
        byte[]? serializedBytes = null;

        foreach (var client in _clients.Values)
        {
            if (!client.IsOpen) continue;

            var shouldSend = false;

            if (entry.Source == "mt" && client.SubscribedToMt)
            {
                shouldSend = true;
            }
            else if (entry.Source == "mthost" && entry.SessionId is not null &&
                     client.IsSubscribedToSession(entry.SessionId))
            {
                shouldSend = true;
            }

            if (shouldSend)
            {
                serializedBytes ??= JsonSerializer.SerializeToUtf8Bytes(entry, AppJsonContext.Default.LogEntryMessage);
                _ = client.TrySendAsync(serializedBytes, SendTimeoutMs);
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _fileWatcher.Unsubscribe(_subscriptionId);
    }
}

/// <summary>
/// Per-client state for log WebSocket connections.
/// Thread-safe for concurrent broadcast and message handling.
/// </summary>
public sealed class LogClient : IDisposable
{
    private readonly WebSocket _ws;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly ConcurrentDictionary<string, byte> _subscribedSessions = new();
    private volatile bool _disposed;

    public string Id { get; }
    public volatile bool SubscribedToMt;

    public bool IsOpen => !_disposed && _ws.State == WebSocketState.Open;

    public LogClient(string id, WebSocket ws)
    {
        Id = id;
        _ws = ws;
    }

    public void AddSubscribedSession(string sessionId) => _subscribedSessions.TryAdd(sessionId, 0);
    public void RemoveSubscribedSession(string sessionId) => _subscribedSessions.TryRemove(sessionId, out _);
    public bool IsSubscribedToSession(string sessionId) => _subscribedSessions.ContainsKey(sessionId);

    public async Task<WebSocketReceiveResult> ReceiveAsync(byte[] buffer, CancellationToken ct)
    {
        return await _ws.ReceiveAsync(buffer, ct);
    }

    public async Task<bool> TrySendAsync(byte[] bytes, int timeoutMs)
    {
        if (_disposed || _ws.State != WebSocketState.Open) return false;

        var acquired = false;
        try
        {
            acquired = await _sendLock.WaitAsync(timeoutMs).ConfigureAwait(false);
            if (!acquired)
            {
                Log.Warn(() => $"[LogWS] Send timeout for client {Id}, dropping message");
                return false;
            }

            if (_disposed || _ws.State != WebSocketState.Open) return false;

            using var cts = new CancellationTokenSource(timeoutMs);
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, cts.Token).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            Log.Warn(() => $"[LogWS] Send cancelled for client {Id}");
            return false;
        }
        catch (WebSocketException)
        {
            return false;
        }
        finally
        {
            if (acquired) _sendLock.Release();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _sendLock.Dispose();
    }
}
