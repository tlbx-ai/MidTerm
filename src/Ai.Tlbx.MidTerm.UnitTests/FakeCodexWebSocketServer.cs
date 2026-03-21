using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Ai.Tlbx.MidTerm.UnitTests;

internal sealed class FakeCodexWebSocketServer : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Task _acceptLoopTask;
    private readonly List<Task> _clientTasks = [];

    private FakeCodexWebSocketServer(
        string endpoint,
        string loadedThreadId,
        string assistantReply)
    {
        Endpoint = endpoint;
        LoadedThreadId = loadedThreadId;
        AssistantReply = assistantReply;
        _listener.Prefixes.Add(ToHttpPrefix(endpoint));
        _listener.Start();
        _acceptLoopTask = Task.Run(AcceptLoopAsync);
    }

    public string Endpoint { get; }

    public string LoadedThreadId { get; }

    public string AssistantReply { get; }

    public static FakeCodexWebSocketServer Start(string loadedThreadId, string assistantReply)
    {
        var endpoint = $"ws://127.0.0.1:{GetFreePort()}/";
        return new FakeCodexWebSocketServer(endpoint, loadedThreadId, assistantReply);
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        _listener.Stop();
        _listener.Close();
        try
        {
            await _acceptLoopTask.ConfigureAwait(false);
        }
        catch
        {
        }

        await Task.WhenAll(_clientTasks.ToArray()).ConfigureAwait(false);
        _shutdown.Dispose();
    }

    private async Task AcceptLoopAsync()
    {
        try
        {
            while (!_shutdown.IsCancellationRequested)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync().ConfigureAwait(false);
                }
                catch (HttpListenerException)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }

                if (context.Request.IsWebSocketRequest)
                {
                    var task = HandleClientAsync(context);
                    lock (_clientTasks)
                    {
                        _clientTasks.Add(task);
                    }

                    _ = task.ContinueWith(_ =>
                    {
                        lock (_clientTasks)
                        {
                            _clientTasks.Remove(task);
                        }
                    }, TaskScheduler.Default);
                    continue;
                }

                context.Response.StatusCode = 200;
                context.Response.Close();
            }
        }
        catch
        {
        }
    }

    private async Task HandleClientAsync(HttpListenerContext context)
    {
        var wsContext = await context.AcceptWebSocketAsync(subProtocol: null).ConfigureAwait(false);
        var socket = wsContext.WebSocket;
        try
        {
            while (!_shutdown.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var message = await ReceiveMessageAsync(socket, _shutdown.Token).ConfigureAwait(false);
                if (message is null)
                {
                    break;
                }

                using var json = JsonDocument.Parse(message);
                var root = json.RootElement;
                if (!root.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                var method = methodElement.GetString() ?? string.Empty;
                var id = root.TryGetProperty("id", out var idElement) ? idElement.ToString() : null;
                var @params = root.TryGetProperty("params", out var paramsElement) ? paramsElement : default;

                switch (method)
                {
                    case "initialize" when id is not null:
                        await SendJsonAsync(socket, new
                        {
                            id,
                            result = new
                            {
                                userAgent = "fake-codex/0.116.0",
                                platformFamily = "windows",
                                platformOs = "windows"
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        break;

                    case "initialized":
                        break;

                    case "thread/loaded/list" when id is not null:
                        await SendJsonAsync(socket, new
                        {
                            id,
                            result = new
                            {
                                data = new[] { LoadedThreadId },
                                nextCursor = (string?)null
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        break;

                    case "thread/resume" when id is not null:
                        await SendJsonAsync(socket, new
                        {
                            id,
                            result = new
                            {
                                thread = new
                                {
                                    id = LoadedThreadId
                                }
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        break;

                    case "thread/start" when id is not null:
                        await SendJsonAsync(socket, new
                        {
                            id,
                            result = new
                            {
                                thread = new
                                {
                                    id = LoadedThreadId
                                }
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        break;

                    case "turn/start" when id is not null:
                        var turnId = "turn-remote-1";
                        await SendJsonAsync(socket, new
                        {
                            id,
                            result = new
                            {
                                turn = new
                                {
                                    id = turnId
                                }
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        await SendJsonAsync(socket, new
                        {
                            method = "turn/started",
                            @params = new
                            {
                                turn = new
                                {
                                    id = turnId,
                                    model = "gpt-5.3-codex",
                                    effort = "medium"
                                }
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        await SendJsonAsync(socket, new
                        {
                            method = "item/agentMessage/delta",
                            @params = new
                            {
                                itemId = "item-agent-1",
                                delta = AssistantReply
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        await SendJsonAsync(socket, new
                        {
                            method = "turn/completed",
                            @params = new
                            {
                                turn = new
                                {
                                    id = turnId,
                                    status = "completed"
                                }
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        break;

                    case "turn/interrupt" when id is not null:
                        await SendJsonAsync(socket, new { id, result = new { } }, _shutdown.Token).ConfigureAwait(false);
                        await SendJsonAsync(socket, new
                        {
                            method = "turn/aborted",
                            @params = new
                            {
                                turnId = GetString(@params, "turnId") ?? "turn-remote-1",
                                reason = "interrupt"
                            }
                        }, _shutdown.Token).ConfigureAwait(false);
                        break;
                }
            }
        }
        catch
        {
        }
        finally
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None).ConfigureAwait(false);
                }
                catch
                {
                }
            }

            socket.Dispose();
        }
    }

    private static string? GetString(JsonElement element, string propertyName)
    {
        return element.ValueKind == JsonValueKind.Object &&
               element.TryGetProperty(propertyName, out var property) &&
               property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }

    private static async Task<string?> ReceiveMessageAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[8192];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            if (result.Count > 0)
            {
                await message.WriteAsync(buffer.AsMemory(0, result.Count), ct).ConfigureAwait(false);
            }

            if (result.EndOfMessage)
            {
                break;
            }
        }

        return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
    }

    private static Task SendJsonAsync(WebSocket socket, object payload, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        return socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, endOfMessage: true, ct);
    }

    private static string ToHttpPrefix(string endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri))
        {
            throw new InvalidOperationException($"Invalid websocket endpoint '{endpoint}'.");
        }

        var builder = new UriBuilder(uri)
        {
            Scheme = uri.Scheme == Uri.UriSchemeWss ? Uri.UriSchemeHttps : Uri.UriSchemeHttp
        };
        return builder.Uri.ToString();
    }

    private static int GetFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
}
