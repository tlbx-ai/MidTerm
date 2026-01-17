using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Voice.Services;
using Ai.Tlbx.VoiceAssistant.Provider.OpenAi;
using Ai.Tlbx.VoiceAssistant.Provider.OpenAi.Models;
using VoiceLogLevel = Ai.Tlbx.VoiceAssistant.Models.LogLevel;
using VoiceOrchestrator = Ai.Tlbx.VoiceAssistant.VoiceAssistant;

namespace Ai.Tlbx.MidTerm.Voice.WebSockets;

/// <summary>
/// Handles WebSocket connections on /voice endpoint for browser audio streaming.
/// </summary>
public sealed class VoiceWebSocketHandler
{
    private readonly VoiceSessionService _sessionService;

    public VoiceWebSocketHandler(VoiceSessionService sessionService)
    {
        _sessionService = sessionService;
    }

    public async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = 400;
            return;
        }

        using var ws = await context.WebSockets.AcceptWebSocketAsync();
        var clientId = Guid.NewGuid().ToString("N")[..8];
        Log.Info(() => $"[Voice] Client {clientId} connected");

        using var cts = new CancellationTokenSource();
        var audioHardware = new WebSocketAudioHardware(ws, cts.Token);

        VoiceOrchestrator? assistant = null;

        try
        {
            await audioHardware.InitAudioAsync();

            var receiveBuffer = new byte[64 * 1024];

            while (ws.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await ws.ReceiveAsync(receiveBuffer, cts.Token);
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

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    var json = Encoding.UTF8.GetString(receiveBuffer, 0, result.Count);
                    var msg = JsonSerializer.Deserialize<VoiceControlMessage>(json, VoiceJsonContext.Default.VoiceControlMessage);

                    if (msg is not null)
                    {
                        assistant = await ProcessControlMessageAsync(msg, assistant, audioHardware, clientId, cts);
                    }
                }
                else if (result.MessageType == WebSocketMessageType.Binary)
                {
                    var base64Audio = Convert.ToBase64String(receiveBuffer, 0, result.Count);
                    audioHardware.OnAudioDataReceived(base64Audio);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Error(() => $"[Voice] Client {clientId} error: {ex.Message}");
            await SendErrorAsync(ws, ex.Message, cts.Token);
        }
        finally
        {
            Log.Info(() => $"[Voice] Client {clientId} disconnecting");

            if (assistant is not null)
            {
                await assistant.DisposeAsync();
            }

            await audioHardware.DisposeAsync();
            cts.Cancel();

            await CloseWebSocketAsync(ws);
        }
    }

    private async Task<VoiceOrchestrator?> ProcessControlMessageAsync(
        VoiceControlMessage msg,
        VoiceOrchestrator? assistant,
        WebSocketAudioHardware audioHardware,
        string clientId,
        CancellationTokenSource cts)
    {
        switch (msg.Type?.ToLowerInvariant())
        {
            case "start":
                return await HandleStartAsync(msg, assistant, audioHardware, clientId, cts.Token);

            case "stop":
                if (assistant is not null)
                {
                    await assistant.StopAsync();
                    Log.Info(() => $"[Voice] Client {clientId} stopped session");
                }
                return assistant;

            default:
                Log.Warn(() => $"[Voice] Unknown message type: {msg.Type}");
                return assistant;
        }
    }

    private async Task<VoiceOrchestrator?> HandleStartAsync(
        VoiceControlMessage msg,
        VoiceOrchestrator? existingAssistant,
        WebSocketAudioHardware audioHardware,
        string clientId,
        CancellationToken cancellationToken)
    {
        if (existingAssistant is not null)
        {
            await existingAssistant.DisposeAsync();
        }

        var apiKey = _sessionService.GetOpenAiApiKey();
        if (string.IsNullOrEmpty(apiKey))
        {
            throw new InvalidOperationException("OpenAI API key not configured");
        }

        var provider = new OpenAiVoiceProvider(apiKey, (level, message) =>
        {
            switch (level)
            {
                case VoiceLogLevel.Error:
                    Log.Error(() => $"[OpenAI] {message}");
                    break;
                case VoiceLogLevel.Warn:
                    Log.Warn(() => $"[OpenAI] {message}");
                    break;
                default:
                    Log.Info(() => $"[OpenAI] {message}");
                    break;
            }
        });

        var assistant = new VoiceOrchestrator(audioHardware, provider, (level, message) =>
        {
            switch (level)
            {
                case VoiceLogLevel.Error:
                    Log.Error(() => $"[VA] {message}");
                    break;
                case VoiceLogLevel.Warn:
                    Log.Warn(() => $"[VA] {message}");
                    break;
                default:
                    Log.Info(() => $"[VA] {message}");
                    break;
            }
        });

        assistant.OnConnectionStatusChanged = status =>
        {
            Log.Info(() => $"[Voice] Client {clientId} status: {status}");
        };

        assistant.OnMessageAdded = chatMessage =>
        {
            Log.Verbose(() => $"[Voice] Client {clientId} message: {chatMessage.Role} - {chatMessage.Content?.Substring(0, Math.Min(50, chatMessage.Content?.Length ?? 0))}...");
        };

        var settings = new OpenAiVoiceSettings
        {
            Instructions = _sessionService.GetSystemPrompt(),
            Model = OpenAiRealtimeModel.Gpt4oRealtimePreview20250603,
            Voice = AssistantVoice.Alloy,
            TalkingSpeed = 1.0,
            TurnDetection = new TurnDetection
            {
                Type = "server_vad",
                Threshold = 0.5,
                PrefixPaddingMs = 300,
                SilenceDurationMs = 500
            }
        };

        Log.Info(() => $"[Voice] Client {clientId} starting session with OpenAI");
        await assistant.StartAsync(settings, cancellationToken);

        return assistant;
    }

    private static async Task SendErrorAsync(WebSocket ws, string message, CancellationToken ct)
    {
        if (ws.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            var errorMsg = new VoiceControlMessage { Type = "error", Message = message };
            var json = JsonSerializer.Serialize(errorMsg, VoiceJsonContext.Default.VoiceControlMessage);
            var bytes = Encoding.UTF8.GetBytes(json);
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        catch
        {
        }
    }

    private static async Task CloseWebSocketAsync(WebSocket ws)
    {
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
