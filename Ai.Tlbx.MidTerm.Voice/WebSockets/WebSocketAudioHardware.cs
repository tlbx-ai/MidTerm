using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.VoiceAssistant.Interfaces;
using Ai.Tlbx.VoiceAssistant.Models;
using VoiceLogLevel = Ai.Tlbx.VoiceAssistant.Models.LogLevel;

namespace Ai.Tlbx.MidTerm.Voice.WebSockets;

/// <summary>
/// Implements IAudioHardwareAccess for WebSocket-based audio streaming.
/// Audio is captured in the browser and sent over WebSocket to this server.
/// </summary>
public sealed class WebSocketAudioHardware : IAudioHardwareAccess
{
    private readonly WebSocket _webSocket;
    private readonly CancellationToken _cancellationToken;
    private readonly Channel<(string Audio, int SampleRate)> _playbackChannel;
    private readonly SemaphoreSlim _playbackDrainSemaphore = new(0, 1);

    private MicrophoneAudioReceivedEventHandler? _audioDataReceivedHandler;
    private Action<VoiceLogLevel, string>? _logAction;
    private DiagnosticLevel _diagnosticLevel = DiagnosticLevel.None;
    private Task? _playbackProcessorTask;
    private bool _isRecording;
    private bool _disposed;

    public event EventHandler<string>? AudioError;

    public WebSocketAudioHardware(WebSocket webSocket, CancellationToken cancellationToken)
    {
        _webSocket = webSocket;
        _cancellationToken = cancellationToken;
        _playbackChannel = Channel.CreateBounded<(string Audio, int SampleRate)>(
            new BoundedChannelOptions(100)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });
    }

    public Task InitAudioAsync()
    {
        _playbackProcessorTask = Task.Run(PlaybackProcessorLoopAsync, _cancellationToken);
        LogVerbose("Audio hardware initialized");
        return Task.CompletedTask;
    }

    public Task<bool> StartRecordingAudio(
        MicrophoneAudioReceivedEventHandler audioDataReceivedHandler,
        AudioSampleRate targetSampleRate = AudioSampleRate.Rate24000)
    {
        _audioDataReceivedHandler = audioDataReceivedHandler;
        _isRecording = true;

        var msg = new VoiceControlMessage { Type = "config", SampleRate = (int)targetSampleRate };
        _ = SendJsonMessageAsync(msg);

        var startMsg = new VoiceControlMessage { Type = "started" };
        _ = SendJsonMessageAsync(startMsg);

        LogInfo($"Recording started (target sample rate: {(int)targetSampleRate}Hz)");
        return Task.FromResult(true);
    }

    public Task<bool> StopRecordingAudio()
    {
        _isRecording = false;
        _audioDataReceivedHandler = null;

        var msg = new VoiceControlMessage { Type = "stopped" };
        _ = SendJsonMessageAsync(msg);

        LogInfo("Recording stopped");
        return Task.FromResult(true);
    }

    public bool PlayAudio(string base64EncodedPcm16Audio, int sampleRate)
    {
        if (_disposed || _webSocket.State != WebSocketState.Open)
        {
            return false;
        }

        return _playbackChannel.Writer.TryWrite((base64EncodedPcm16Audio, sampleRate));
    }

    public async Task ClearAudioQueueAsync()
    {
        while (_playbackChannel.Reader.TryRead(out _))
        {
        }

        var msg = new VoiceControlMessage { Type = "clear" };
        await SendJsonMessageAsync(msg);
        LogVerbose("Audio queue cleared");
    }

    public async Task<bool> WaitForPlaybackDrainAsync(TimeSpan? timeout = null)
    {
        timeout ??= TimeSpan.FromSeconds(30);

        if (_playbackChannel.Reader.Count == 0)
        {
            return true;
        }

        try
        {
            return await _playbackDrainSemaphore.WaitAsync(timeout.Value, _cancellationToken);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    public Task<List<AudioDeviceInfo>> GetAvailableMicrophonesAsync()
    {
        return Task.FromResult(new List<AudioDeviceInfo>
        {
            new() { Id = "browser-default", Name = "Browser Microphone", IsDefault = true }
        });
    }

    public Task<List<AudioDeviceInfo>> RequestMicrophonePermissionAndGetDevicesAsync()
    {
        return GetAvailableMicrophonesAsync();
    }

    public Task<bool> SetMicrophoneDeviceAsync(string deviceId)
    {
        LogVerbose($"SetMicrophoneDevice: {deviceId} (browser controls device selection)");
        return Task.FromResult(true);
    }

    public Task<string?> GetCurrentMicrophoneDeviceAsync()
    {
        return Task.FromResult<string?>("browser-default");
    }

    public Task<bool> SetDiagnosticLevelAsync(DiagnosticLevel level)
    {
        _diagnosticLevel = level;
        return Task.FromResult(true);
    }

    public Task<DiagnosticLevel> GetDiagnosticLevelAsync()
    {
        return Task.FromResult(_diagnosticLevel);
    }

    public void SetLogAction(Action<VoiceLogLevel, string>? logAction)
    {
        _logAction = logAction;
    }

    /// <summary>
    /// Called by the handler when audio data is received from the browser WebSocket.
    /// </summary>
    public void OnAudioDataReceived(string base64Audio)
    {
        if (!_isRecording || _audioDataReceivedHandler is null)
        {
            return;
        }

        try
        {
            _audioDataReceivedHandler.Invoke(this, new MicrophoneAudioReceivedEventArgs(base64Audio));
        }
        catch (Exception ex)
        {
            LogError($"Error invoking audio handler: {ex.Message}");
            AudioError?.Invoke(this, ex.Message);
        }
    }

    private async Task PlaybackProcessorLoopAsync()
    {
        try
        {
            await foreach (var (audio, sampleRate) in _playbackChannel.Reader.ReadAllAsync(_cancellationToken))
            {
                if (_webSocket.State != WebSocketState.Open)
                {
                    break;
                }

                var bytes = Convert.FromBase64String(audio);
                await _webSocket.SendAsync(bytes, WebSocketMessageType.Binary, true, _cancellationToken);
                LogVerbose($"Sent {bytes.Length} bytes of audio at {sampleRate}Hz");

                if (_playbackChannel.Reader.Count == 0)
                {
                    try
                    {
                        _playbackDrainSemaphore.Release();
                    }
                    catch (SemaphoreFullException)
                    {
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (WebSocketException ex)
        {
            LogError($"WebSocket error in playback: {ex.Message}");
        }
    }

    private async Task SendJsonMessageAsync(VoiceControlMessage message)
    {
        if (_webSocket.State != WebSocketState.Open)
        {
            return;
        }

        try
        {
            var json = JsonSerializer.Serialize(message, VoiceJsonContext.Default.VoiceControlMessage);
            var bytes = Encoding.UTF8.GetBytes(json);
            await _webSocket.SendAsync(bytes, WebSocketMessageType.Text, true, _cancellationToken);
        }
        catch (WebSocketException ex)
        {
            LogError($"Failed to send control message: {ex.Message}");
        }
    }

    private void LogInfo(string message)
    {
        _logAction?.Invoke(VoiceLogLevel.Info, $"[WebSocketHW] {message}");
        if (_diagnosticLevel >= DiagnosticLevel.Basic)
        {
            Log.Info(() => $"[WebSocketHW] {message}");
        }
    }

    private void LogVerbose(string message)
    {
        if (_diagnosticLevel >= DiagnosticLevel.Verbose)
        {
            _logAction?.Invoke(VoiceLogLevel.Info, $"[WebSocketHW] {message}");
            Log.Verbose(() => $"[WebSocketHW] {message}");
        }
    }

    private void LogError(string message)
    {
        _logAction?.Invoke(VoiceLogLevel.Error, $"[WebSocketHW] {message}");
        Log.Error(() => $"[WebSocketHW] {message}");
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _playbackChannel.Writer.Complete();

        if (_playbackProcessorTask is not null)
        {
            try
            {
                await _playbackProcessorTask.WaitAsync(TimeSpan.FromSeconds(2));
            }
            catch
            {
            }
        }

        _playbackDrainSemaphore.Dispose();
        LogVerbose("WebSocketAudioHardware disposed");
    }
}

/// <summary>
/// Control messages sent between browser and server.
/// </summary>
public class VoiceControlMessage
{
    public string Type { get; set; } = "";
    public string? Provider { get; set; }
    public int? SampleRate { get; set; }
    public string? Message { get; set; }
    public bool? Active { get; set; }
}
