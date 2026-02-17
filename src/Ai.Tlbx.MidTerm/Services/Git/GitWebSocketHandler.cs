using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Git;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Git;

public sealed class GitWebSocketHandler
{
    private readonly GitWatcherService _gitWatcher;
    private readonly SettingsService _settingsService;
    private readonly AuthService _authService;
    private readonly ShutdownService _shutdownService;

    public GitWebSocketHandler(
        GitWatcherService gitWatcher,
        SettingsService settingsService,
        AuthService authService,
        ShutdownService shutdownService)
    {
        _gitWatcher = gitWatcher;
        _settingsService = settingsService;
        _authService = authService;
        _shutdownService = shutdownService;
    }

    public async Task HandleAsync(HttpContext context)
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

        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var sendLock = new SemaphoreSlim(1, 1);
        var subscribedSessions = new HashSet<string>();

        async Task SendMessageAsync(GitWsMessage message)
        {
            if (ws.State != WebSocketState.Open) return;

            await sendLock.WaitAsync();
            try
            {
                if (ws.State != WebSocketState.Open) return;

                var bytes = JsonSerializer.SerializeToUtf8Bytes(message, GitJsonContext.Default.GitWsMessage);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (WebSocketException) { }
            catch (ObjectDisposedException) { }
            catch (Exception ex)
            {
                Log.Verbose(() => $"[GitWS] SendMessageAsync failed: {ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                sendLock.Release();
            }
        }

        void OnStatusChanged(string repoRoot, GitStatusResponse status)
        {
            lock (subscribedSessions)
            {
                foreach (var sessionId in subscribedSessions)
                {
                    var sessionRepo = _gitWatcher.GetRepoRoot(sessionId);
                    if (string.Equals(sessionRepo, repoRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        _ = SendMessageAsync(new GitWsMessage
                        {
                            Type = "status",
                            SessionId = sessionId,
                            Status = status
                        });
                    }
                }
            }
        }

        _gitWatcher.OnStatusChanged += OnStatusChanged;
        var shutdownToken = _shutdownService.Token;

        try
        {
            var buffer = new byte[4096];
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
                        messageBuffer.AddRange(buffer.AsSpan(0, result.Count).ToArray());

                        if (result.EndOfMessage)
                        {
                            var json = Encoding.UTF8.GetString(messageBuffer.ToArray());
                            messageBuffer.Clear();

                            await HandleClientMessageAsync(json, subscribedSessions, SendMessageAsync);
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
            _gitWatcher.OnStatusChanged -= OnStatusChanged;
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

    private async Task HandleClientMessageAsync(
        string json,
        HashSet<string> subscribedSessions,
        Func<GitWsMessage, Task> sendMessage)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var type = root.TryGetProperty("type", out var typeProp) ? typeProp.GetString() : null;
            var sessionId = root.TryGetProperty("sessionId", out var sidProp) ? sidProp.GetString() : null;

            if (string.IsNullOrEmpty(type) || string.IsNullOrEmpty(sessionId)) return;

            switch (type)
            {
                case "subscribe":
                    lock (subscribedSessions)
                    {
                        subscribedSessions.Add(sessionId);
                    }

                    var cached = _gitWatcher.GetCachedStatus(sessionId);
                    if (cached is not null)
                    {
                        await sendMessage(new GitWsMessage
                        {
                            Type = "status",
                            SessionId = sessionId,
                            Status = cached
                        });
                    }
                    break;

                case "unsubscribe":
                    lock (subscribedSessions)
                    {
                        subscribedSessions.Remove(sessionId);
                    }
                    break;
            }
        }
        catch (JsonException ex)
        {
            Log.Verbose(() => $"[GitWS] Failed to parse client message: {ex.Message}");
        }
    }
}
