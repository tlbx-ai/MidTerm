using System.IO.Pipes;
using System.Threading.Channels;

namespace Ai.Tlbx.MiddleManager.Services;

/// <summary>
/// Robust IPC client for a single mm-con-host process.
/// Auto-reconnects on failure, retries operations, buffers during disconnects.
/// </summary>
public sealed class ConHostClient : IAsyncDisposable
{
    private readonly string _sessionId;
    private readonly string _pipeName;
    private readonly object _pipeLock = new();
    private readonly object _responseLock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1); // Serialize ALL pipe writes to prevent frame interleaving
    private readonly SemaphoreSlim _requestLock = new(1, 1); // Serialize requests to avoid response routing conflicts

    private NamedPipeClientStream? _pipe;
    private CancellationTokenSource? _cts;
    private Task? _readTask;
    private Task? _reconnectTask;
    private bool _disposed;
    private bool _intentionalDisconnect;
    private int _reconnectAttempts;

    // For request/response coordination
    private TaskCompletionSource<(ConHostMessageType type, byte[] payload)>? _pendingResponse;

    // Reconnection settings
    private const int MaxReconnectAttempts = 10;
    private const int InitialReconnectDelayMs = 100;
    private const int MaxReconnectDelayMs = 5000;

    public string SessionId => _sessionId;
    public bool IsConnected => _pipe?.IsConnected ?? false;

    public event Action<string, int, int, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;
    public event Action<string>? OnDisconnected;
    public event Action<string>? OnReconnected;

    public ConHostClient(string sessionId)
    {
        _sessionId = sessionId;
        _pipeName = ConHostProtocol.GetPipeName(sessionId);
    }

    public async Task<bool> ConnectAsync(int timeoutMs = 5000, CancellationToken ct = default)
    {
        if (_disposed) return false;

        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                lock (_pipeLock)
                {
                    _pipe?.Dispose();
                    _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                }

                await _pipe.ConnectAsync(timeoutMs, ct).ConfigureAwait(false);
                _reconnectAttempts = 0;
                Log($"Connected to pipe {_pipeName}");
                return true;
            }
            catch (TimeoutException)
            {
                Log($"Connection timeout (attempt {attempt + 1}/3)");
            }
            catch (IOException ex)
            {
                Log($"Connection failed (attempt {attempt + 1}/3): {ex.Message}");
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            catch (Exception ex)
            {
                Log($"Unexpected connection error: {ex.Message}");
            }

            if (attempt < 2)
            {
                await Task.Delay(200 * (attempt + 1), ct).ConfigureAwait(false);
            }
        }

        return false;
    }

    public void StartReadLoop()
    {
        if (_readTask is not null) return;
        _cts = new CancellationTokenSource();
        _readTask = ReadLoopWithReconnectAsync(_cts.Token);
    }

    public async Task<SessionInfo?> GetInfoAsync(CancellationToken ct = default)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (!IsConnected)
            {
                await Task.Delay(100, ct).ConfigureAwait(false);
                continue;
            }

            try
            {
                // If read loop is running, use request/response pattern to avoid concurrent reads
                if (_readTask is not null)
                {
                    var request = ConHostProtocol.CreateInfoRequest();
                    var response = await SendRequestAsync(request, ConHostMessageType.Info, ct).ConfigureAwait(false);
                    if (response is null) continue;
                    return ConHostProtocol.ParseInfo(response);
                }

                // Before read loop starts (initial handshake), read directly
                var requestBytes = ConHostProtocol.CreateInfoRequest();
                await WriteWithLockAsync(requestBytes, ct).ConfigureAwait(false);

                var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
                if (directResponse is null) continue;

                var (type, payload) = directResponse.Value;
                if (type != ConHostMessageType.Info)
                {
                    Log($"GetInfo got unexpected message type: {type}");
                    continue;
                }

                return ConHostProtocol.ParseInfo(payload.Span);
            }
            catch (Exception ex)
            {
                Log($"GetInfo failed (attempt {attempt + 1}): {ex.Message}");
            }
        }

        return null;
    }

    public async Task SendInputAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        if (_disposed) return;

        try
        {
            if (data.Length < 20)
            {
                DebugLogger.Log($"[PIPE-SEND] {_sessionId}: {BitConverter.ToString(data.ToArray())}");
            }
            var msg = ConHostProtocol.CreateInputMessage(data.Span);
            await WriteWithLockAsync(msg, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log($"SendInput failed: {ex.Message}");
            TriggerReconnect();
        }
    }

    private async Task WriteWithLockAsync(byte[] data, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await WriteAsync(data, ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task<bool> ResizeAsync(int cols, int rows, CancellationToken ct = default)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (!IsConnected) return false;

            try
            {
                var msg = ConHostProtocol.CreateResizeMessage(cols, rows);
                var response = await SendRequestAsync(msg, ConHostMessageType.ResizeAck, ct).ConfigureAwait(false);
                return response is not null;
            }
            catch (Exception ex)
            {
                Log($"Resize failed (attempt {attempt + 1}): {ex.Message}");
                TriggerReconnect();
            }
        }

        return false;
    }

    public async Task<byte[]?> GetBufferAsync(CancellationToken ct = default)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (!IsConnected) return null;

            try
            {
                var msg = ConHostProtocol.CreateGetBuffer();
                var response = await SendRequestAsync(msg, ConHostMessageType.Buffer, ct).ConfigureAwait(false);
                return response;
            }
            catch (Exception ex)
            {
                Log($"GetBuffer failed (attempt {attempt + 1}): {ex.Message}");
            }
        }

        return null;
    }

    public async Task<bool> SetNameAsync(string? name, CancellationToken ct = default)
    {
        if (!IsConnected) return false;

        try
        {
            var msg = ConHostProtocol.CreateSetName(name);
            var response = await SendRequestAsync(msg, ConHostMessageType.SetNameAck, ct).ConfigureAwait(false);
            return response is not null;
        }
        catch (Exception ex)
        {
            Log($"SetName failed: {ex.Message}");
            return false;
        }
    }

    public async Task<bool> CloseAsync(CancellationToken ct = default)
    {
        _intentionalDisconnect = true;

        if (!IsConnected) return true;

        try
        {
            var msg = ConHostProtocol.CreateClose();
            var response = await SendRequestAsync(msg, ConHostMessageType.CloseAck, ct).ConfigureAwait(false);
            return response is not null;
        }
        catch (Exception ex)
        {
            DebugLogger.LogException($"ConHostClient.CloseAsync({_sessionId})", ex);
            return true; // Session closing anyway
        }
    }

    private async Task<byte[]?> SendRequestAsync(byte[] request, ConHostMessageType expectedType, CancellationToken ct)
    {
        // Serialize requests to prevent response routing conflicts
        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var tcs = new TaskCompletionSource<(ConHostMessageType type, byte[] payload)>();

            lock (_responseLock)
            {
                _pendingResponse = tcs;
            }

            try
            {
                await WriteWithLockAsync(request, ct).ConfigureAwait(false);

                using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

                var response = await tcs.Task.WaitAsync(linkedCts.Token).ConfigureAwait(false);
                return response.type == expectedType ? response.payload : null;
            }
            finally
            {
                lock (_responseLock)
                {
                    _pendingResponse = null;
                }
            }
        }
        finally
        {
            _requestLock.Release();
        }
    }

    private async Task WriteAsync(byte[] data, CancellationToken ct)
    {
        var pipe = _pipe;
        if (pipe is null || !pipe.IsConnected)
        {
            throw new IOException("Pipe not connected");
        }

        await pipe.WriteAsync(data, ct).ConfigureAwait(false);
        await pipe.FlushAsync(ct).ConfigureAwait(false);
    }

    private async Task ReadLoopWithReconnectAsync(CancellationToken ct)
    {
        var headerBuffer = new byte[ConHostProtocol.HeaderSize];

        while (!ct.IsCancellationRequested && !_disposed)
        {
            try
            {
                if (!IsConnected)
                {
                    DebugLogger.Log($"[READ-LOOP] {_sessionId}: Not connected, waiting...");
                    await Task.Delay(100, ct).ConfigureAwait(false);
                    continue;
                }

                var pipe = _pipe;
                if (pipe is null) continue;

                var bytesRead = await pipe.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
                DebugLogger.Log($"[READ-LOOP] {_sessionId}: Read {bytesRead} bytes");
                if (bytesRead == 0)
                {
                    Log("Read returned 0 bytes - pipe closed");
                    DebugLogger.Log($"[PIPE-ERR] {_sessionId}: Read returned 0 bytes - pipe closed");
                    HandleDisconnect();
                    continue;
                }

                // Read remaining header if needed
                while (bytesRead < ConHostProtocol.HeaderSize)
                {
                    var more = await pipe.ReadAsync(headerBuffer.AsMemory(bytesRead), ct).ConfigureAwait(false);
                    if (more == 0)
                    {
                        HandleDisconnect();
                        break;
                    }
                    bytesRead += more;
                }

                if (bytesRead < ConHostProtocol.HeaderSize) continue;

                if (!ConHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
                {
                    Log($"Invalid header: {BitConverter.ToString(headerBuffer)}");
                    // Protocol desync'd - can't recover without reconnecting
                    HandleDisconnect();
                    break;
                }

                // Read payload - allocate dynamically based on actual size
                byte[] payloadBuffer = [];
                if (payloadLength > 0)
                {
                    payloadBuffer = new byte[payloadLength];
                    var totalRead = 0;
                    while (totalRead < payloadLength)
                    {
                        var chunk = await pipe.ReadAsync(payloadBuffer.AsMemory(totalRead, payloadLength - totalRead), ct).ConfigureAwait(false);
                        if (chunk == 0)
                        {
                            HandleDisconnect();
                            break;
                        }
                        totalRead += chunk;
                    }

                    if (totalRead < payloadLength) continue;
                }

                var payload = payloadBuffer.AsMemory(0, payloadLength);
                DebugLogger.Log($"[READ-LOOP] {_sessionId}: Processing message type {msgType}, payload {payloadLength} bytes");
                ProcessMessage(msgType, payload);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (IOException ex)
            {
                Log($"Read error: {ex.Message}");
                DebugLogger.LogException($"ConHostClient.ReadLoop({_sessionId})", ex);
                HandleDisconnect();
            }
            catch (Exception ex)
            {
                Log($"Unexpected read error: {ex.Message}");
                DebugLogger.LogException($"ConHostClient.ReadLoop({_sessionId})", ex);
                HandleDisconnect();
            }
        }
    }

    private void ProcessMessage(ConHostMessageType msgType, Memory<byte> payload)
    {
        switch (msgType)
        {
            case ConHostMessageType.Output:
                try
                {
                    // Parse dimensions from output message: [cols:2][rows:2][data]
                    var (cols, rows) = ConHostProtocol.ParseOutputDimensions(payload.Span);
                    var data = ConHostProtocol.GetOutputData(payload.Span);
                    OnOutput?.Invoke(_sessionId, cols, rows, data.ToArray());
                }
                catch (Exception ex)
                {
                    DebugLogger.LogException($"ConHostClient.OnOutput({_sessionId})", ex);
                }
                break;

            case ConHostMessageType.StateChange:
                try
                {
                    OnStateChanged?.Invoke(_sessionId);
                }
                catch (Exception ex)
                {
                    DebugLogger.LogException($"ConHostClient.OnStateChanged({_sessionId})", ex);
                }
                break;

            // Response messages - route to pending request
            case ConHostMessageType.Buffer:
            case ConHostMessageType.ResizeAck:
            case ConHostMessageType.SetNameAck:
            case ConHostMessageType.CloseAck:
            case ConHostMessageType.Info:
                lock (_responseLock)
                {
                    _pendingResponse?.TrySetResult((msgType, payload.ToArray()));
                }
                break;

            default:
                Log($"Unknown message type: {msgType}");
                break;
        }
    }

    private void HandleDisconnect()
    {
        if (_disposed || _intentionalDisconnect) return;

        Log("Connection lost, will attempt reconnect");
        OnDisconnected?.Invoke(_sessionId);
        TriggerReconnect();
    }

    private void TriggerReconnect()
    {
        if (_disposed || _intentionalDisconnect) return;
        if (_reconnectTask is not null && !_reconnectTask.IsCompleted) return;

        _reconnectTask = ReconnectAsync();
    }

    private async Task ReconnectAsync()
    {
        while (!_disposed && !_intentionalDisconnect && _reconnectAttempts < MaxReconnectAttempts)
        {
            _reconnectAttempts++;
            var delay = Math.Min(InitialReconnectDelayMs * (1 << _reconnectAttempts), MaxReconnectDelayMs);
            Log($"Reconnect attempt {_reconnectAttempts}/{MaxReconnectAttempts} in {delay}ms");

            await Task.Delay(delay).ConfigureAwait(false);

            if (_disposed || _intentionalDisconnect) return;

            try
            {
                lock (_pipeLock)
                {
                    _pipe?.Dispose();
                    _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                }

                await _pipe.ConnectAsync(2000).ConfigureAwait(false);

                // Re-handshake
                var info = await GetInfoAsync().ConfigureAwait(false);
                if (info is not null)
                {
                    _reconnectAttempts = 0;
                    Log("Reconnected successfully");
                    OnReconnected?.Invoke(_sessionId);
                    return;
                }
            }
            catch (Exception ex)
            {
                Log($"Reconnect failed: {ex.Message}");
                DebugLogger.LogException($"ConHostClient.Reconnect({_sessionId}) attempt {_reconnectAttempts}", ex);
            }
        }

        if (_reconnectAttempts >= MaxReconnectAttempts)
        {
            Log("Max reconnect attempts reached, giving up");
            DebugLogger.LogError($"ConHostClient.Reconnect({_sessionId})", $"Max reconnect attempts ({MaxReconnectAttempts}) reached, giving up");
            OnStateChanged?.Invoke(_sessionId);
        }
    }

    private async Task<(ConHostMessageType type, Memory<byte> payload)?> ReadMessageAsync(CancellationToken ct)
    {
        var pipe = _pipe;
        if (pipe is null || !pipe.IsConnected) return null;

        var headerBuffer = new byte[ConHostProtocol.HeaderSize];
        var bytesRead = await pipe.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
        if (bytesRead == 0) return null;

        while (bytesRead < ConHostProtocol.HeaderSize)
        {
            var more = await pipe.ReadAsync(headerBuffer.AsMemory(bytesRead), ct).ConfigureAwait(false);
            if (more == 0) return null;
            bytesRead += more;
        }

        if (!ConHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
        {
            return null;
        }

        var payload = new byte[payloadLength];
        if (payloadLength > 0)
        {
            var totalRead = 0;
            while (totalRead < payloadLength)
            {
                var chunk = await pipe.ReadAsync(payload.AsMemory(totalRead), ct).ConfigureAwait(false);
                if (chunk == 0) return null;
                totalRead += chunk;
            }
        }

        return (msgType, payload);
    }

    private static void Log(string message)
    {
        Console.WriteLine($"[ConHostClient] {message}");
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _intentionalDisconnect = true;

        _cts?.Cancel();

        // Cancel any pending responses
        lock (_responseLock)
        {
            _pendingResponse?.TrySetCanceled();
        }

        if (_readTask is not null)
        {
            try { await _readTask.ConfigureAwait(false); }
            catch (Exception ex) { DebugLogger.LogException($"ConHostClient.Dispose.ReadTask({_sessionId})", ex); }
        }

        if (_reconnectTask is not null)
        {
            try { await _reconnectTask.ConfigureAwait(false); }
            catch (Exception ex) { DebugLogger.LogException($"ConHostClient.Dispose.ReconnectTask({_sessionId})", ex); }
        }

        _cts?.Dispose();
        _writeLock.Dispose();
        _requestLock.Dispose();

        lock (_pipeLock)
        {
            _pipe?.Dispose();
        }
    }
}
