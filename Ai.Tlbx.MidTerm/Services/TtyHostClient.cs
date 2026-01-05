using System.Net.Sockets;
#if WINDOWS
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
#endif
using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Robust IPC client for a single mmttyhost process.
/// Auto-reconnects on failure, retries operations, buffers during disconnects.
/// </summary>
public sealed class TtyHostClient : IAsyncDisposable
{
#if WINDOWS
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(
        SafePipeHandle hNamedPipe,
        IntPtr lpBuffer,
        uint nBufferSize,
        IntPtr lpBytesRead,
        out uint lpTotalBytesAvail,
        IntPtr lpBytesLeftThisMessage);
#endif
    private readonly string _sessionId;
    private readonly string _endpoint;
    private readonly object _streamLock = new();
    private readonly object _responseLock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly SemaphoreSlim _requestLock = new(1, 1);

#if WINDOWS
    private NamedPipeClientStream? _pipe;
#else
    private Socket? _socket;
    private NetworkStream? _networkStream;
#endif
    private Stream? _stream;
    private CancellationTokenSource? _cts;
    private Task? _readTask;
    private Task? _heartbeatTask;
    private Task? _reconnectTask;
    private CancellationTokenSource? _readCancellation; // Allows heartbeat to unblock reads instantly
    private bool _disposed;
    private bool _intentionalDisconnect;
    private int _reconnectAttempts;
    private DateTime _lastDataReceived = DateTime.UtcNow;

    private TaskCompletionSource<(TtyHostMessageType type, byte[] payload)>? _pendingResponse;

    private const int MaxReconnectAttempts = int.MaxValue; // Never give up - terminal has precious unsaved data
    private const int InitialReconnectDelayMs = 100;
    private const int MaxReconnectDelayMs = 30000; // Cap at 30s between attempts
    private const int HeartbeatIntervalMs = 3000; // Check connection every 3 seconds
    private const int ReadTimeoutMs = 10000; // 10 seconds - shorter now that we have heartbeat

    public string SessionId => _sessionId;
    public bool IsConnected
    {
        get
        {
#if WINDOWS
            return _pipe?.IsConnected ?? false;
#else
            return _socket?.Connected ?? false;
#endif
        }
    }

    public event Action<string, int, int, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;
    public event Action<string>? OnDisconnected;
    public event Action<string>? OnReconnected;

    public TtyHostClient(string sessionId)
    {
        _sessionId = sessionId;
        _endpoint = IpcEndpoint.GetSessionEndpoint(sessionId);
    }

    public async Task<bool> ConnectAsync(int timeoutMs = 5000, CancellationToken ct = default)
    {
        if (_disposed) return false;

        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
#if WINDOWS
                lock (_streamLock)
                {
                    _pipe?.Dispose();
                    _pipe = new NamedPipeClientStream(".", _endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
                }

                await _pipe.ConnectAsync(timeoutMs, ct).ConfigureAwait(false);
                _stream = _pipe;
#else
                lock (_streamLock)
                {
                    _networkStream?.Dispose();
                    _socket?.Dispose();
                    _socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                }

                using var timeoutCts = new CancellationTokenSource(timeoutMs);
                using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

                await _socket.ConnectAsync(new UnixDomainSocketEndPoint(_endpoint), linkedCts.Token).ConfigureAwait(false);
                _networkStream = new NetworkStream(_socket, ownsSocket: false);
                _stream = _networkStream;
#endif
                _reconnectAttempts = 0;
                Log($"Connected to {_endpoint}");
                return true;
            }
            catch (TimeoutException)
            {
                Log($"Connection timeout (attempt {attempt + 1}/3)");
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            catch (Exception ex) when (ex is IOException or SocketException)
            {
                Log($"Connection failed (attempt {attempt + 1}/3): {ex.Message}");
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
        _heartbeatTask = HeartbeatLoopAsync(_cts.Token);
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
                if (_readTask is not null)
                {
                    var request = TtyHostProtocol.CreateInfoRequest();
                    var response = await SendRequestAsync(request, TtyHostMessageType.Info, ct).ConfigureAwait(false);
                    if (response is null) continue;
                    return TtyHostProtocol.ParseInfo(response);
                }

                var requestBytes = TtyHostProtocol.CreateInfoRequest();
                await WriteWithLockAsync(requestBytes, ct).ConfigureAwait(false);

                var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
                if (directResponse is null) continue;

                var (type, payload) = directResponse.Value;
                if (type != TtyHostMessageType.Info)
                {
                    Log($"GetInfo got unexpected message type: {type}");
                    continue;
                }

                return TtyHostProtocol.ParseInfo(payload.Span);
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
                DebugLogger.Log($"[IPC-SEND] {_sessionId}: {BitConverter.ToString(data.ToArray())}");
            }
            var msg = TtyHostProtocol.CreateInputMessage(data.Span);
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
                var msg = TtyHostProtocol.CreateResizeMessage(cols, rows);
                var response = await SendRequestAsync(msg, TtyHostMessageType.ResizeAck, ct).ConfigureAwait(false);
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
                var msg = TtyHostProtocol.CreateGetBuffer();
                var response = await SendRequestAsync(msg, TtyHostMessageType.Buffer, ct).ConfigureAwait(false);
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
            var msg = TtyHostProtocol.CreateSetName(name);
            var response = await SendRequestAsync(msg, TtyHostMessageType.SetNameAck, ct).ConfigureAwait(false);
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
            var msg = TtyHostProtocol.CreateClose();
            var response = await SendRequestAsync(msg, TtyHostMessageType.CloseAck, ct).ConfigureAwait(false);
            return response is not null;
        }
        catch (Exception ex)
        {
            DebugLogger.LogException($"TtyHostClient.CloseAsync({_sessionId})", ex);
            return true;
        }
    }

    private async Task<byte[]?> SendRequestAsync(byte[] request, TtyHostMessageType expectedType, CancellationToken ct)
    {
        await _requestLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var tcs = new TaskCompletionSource<(TtyHostMessageType type, byte[] payload)>();

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
        var stream = _stream;
        if (stream is null || !IsConnected)
        {
            throw new IOException("Not connected");
        }

        await stream.WriteAsync(data, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    private async Task ReadLoopWithReconnectAsync(CancellationToken ct)
    {
        var headerBuffer = new byte[TtyHostProtocol.HeaderSize];

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

                var stream = _stream;
                if (stream is null) continue;

                // Create cancellation that heartbeat can use to unblock us immediately
                _readCancellation?.Dispose();
                _readCancellation = new CancellationTokenSource();

                // Use timeout on read to detect stale connections after standby/resume
                // If the pipe is broken, ReadAsync may hang forever without throwing
                using var readTimeoutCts = new CancellationTokenSource(ReadTimeoutMs);
                using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, readTimeoutCts.Token, _readCancellation.Token);

                int bytesRead;
                try
                {
                    bytesRead = await stream.ReadAsync(headerBuffer, linkedCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (_readCancellation?.IsCancellationRequested == true && !ct.IsCancellationRequested)
                {
                    // Heartbeat cancelled us - reconnect is already triggered, just continue to pick up new stream
                    Log("Read cancelled by heartbeat - reconnecting");
                    continue;
                }
                catch (OperationCanceledException) when (readTimeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
                {
                    // Read timed out - terminal may be idle, this is normal
                    // Heartbeat (PeekNamedPipe/socket poll every 3s) handles stale connection detection
                    // No need to send probe messages that leave orphan responses
                    DebugLogger.Log($"[READ-LOOP] {_sessionId}: Read timeout (idle terminal), continuing");
                    continue;
                }

                _lastDataReceived = DateTime.UtcNow;
                DebugLogger.Log($"[READ-LOOP] {_sessionId}: Read {bytesRead} bytes");
                if (bytesRead == 0)
                {
                    Log("Read returned 0 bytes - connection closed");
                    DebugLogger.Log($"[IPC-ERR] {_sessionId}: Read returned 0 bytes - connection closed");
                    HandleDisconnect();
                    continue;
                }

                while (bytesRead < TtyHostProtocol.HeaderSize)
                {
                    var more = await stream.ReadAsync(headerBuffer.AsMemory(bytesRead), ct).ConfigureAwait(false);
                    if (more == 0)
                    {
                        HandleDisconnect();
                        break;
                    }
                    bytesRead += more;
                }

                if (bytesRead < TtyHostProtocol.HeaderSize) continue;

                if (!TtyHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
                {
                    Log($"Invalid header: {BitConverter.ToString(headerBuffer)}");
                    HandleDisconnect();
                    break;
                }

                byte[] payloadBuffer = [];
                if (payloadLength > 0)
                {
                    payloadBuffer = new byte[payloadLength];
                    var totalRead = 0;
                    while (totalRead < payloadLength)
                    {
                        var chunk = await stream.ReadAsync(payloadBuffer.AsMemory(totalRead, payloadLength - totalRead), ct).ConfigureAwait(false);
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
            catch (Exception ex) when (ex is IOException or SocketException)
            {
                Log($"Read error: {ex.Message}");
                DebugLogger.LogException($"TtyHostClient.ReadLoop({_sessionId})", ex);
                HandleDisconnect();
            }
            catch (Exception ex)
            {
                Log($"Unexpected read error: {ex.Message}");
                DebugLogger.LogException($"TtyHostClient.ReadLoop({_sessionId})", ex);
                HandleDisconnect();
            }
        }
    }

    private void ProcessMessage(TtyHostMessageType msgType, Memory<byte> payload)
    {
        switch (msgType)
        {
            case TtyHostMessageType.Output:
                try
                {
                    var (cols, rows) = TtyHostProtocol.ParseOutputDimensions(payload.Span);
                    var data = TtyHostProtocol.GetOutputData(payload.Span);
                    OnOutput?.Invoke(_sessionId, cols, rows, data.ToArray());
                }
                catch (Exception ex)
                {
                    DebugLogger.LogException($"TtyHostClient.OnOutput({_sessionId})", ex);
                }
                break;

            case TtyHostMessageType.StateChange:
                try
                {
                    OnStateChanged?.Invoke(_sessionId);
                }
                catch (Exception ex)
                {
                    DebugLogger.LogException($"TtyHostClient.OnStateChanged({_sessionId})", ex);
                }
                break;

            case TtyHostMessageType.Buffer:
            case TtyHostMessageType.ResizeAck:
            case TtyHostMessageType.SetNameAck:
            case TtyHostMessageType.CloseAck:
            case TtyHostMessageType.Info:
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

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && !_disposed)
        {
            try
            {
                await Task.Delay(HeartbeatIntervalMs, ct).ConfigureAwait(false);

                if (_disposed || _intentionalDisconnect || !IsConnected) continue;

                // Use PeekNamedPipe on Windows for instant stale detection
#if WINDOWS
                var pipe = _pipe;
                if (pipe is not null && pipe.IsConnected)
                {
                    try
                    {
                        var handle = pipe.SafePipeHandle;
                        if (!PeekNamedPipe(handle, IntPtr.Zero, 0, IntPtr.Zero, out _, IntPtr.Zero))
                        {
                            var error = Marshal.GetLastWin32Error();
                            Log($"PeekNamedPipe failed (error {error}) - pipe is stale");
                            CancelReadAndReconnect();
                        }
                    }
                    catch (ObjectDisposedException)
                    {
                        // Pipe was disposed, will reconnect
                    }
                }
#else
                // On Unix, try a zero-byte write to detect broken socket
                var socket = _socket;
                if (socket is not null && socket.Connected)
                {
                    try
                    {
                        // Poll for error condition
                        if (socket.Poll(0, SelectMode.SelectError))
                        {
                            Log("Socket poll detected error - connection stale");
                            CancelReadAndReconnect();
                        }
                    }
                    catch (SocketException)
                    {
                        CancelReadAndReconnect();
                    }
                    catch (ObjectDisposedException)
                    {
                        // Socket was disposed, will reconnect
                    }
                }
#endif
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                DebugLogger.Log($"[HEARTBEAT] {_sessionId}: Error: {ex.Message}");
            }
        }
    }

    private void CancelReadAndReconnect()
    {
        // Cancel any pending read immediately so we can reconnect faster
        try { _readCancellation?.Cancel(); } catch { }
        HandleDisconnect();
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
#if WINDOWS
                lock (_streamLock)
                {
                    _pipe?.Dispose();
                    _pipe = new NamedPipeClientStream(".", _endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
                }

                await _pipe.ConnectAsync(2000).ConfigureAwait(false);
                _stream = _pipe;
#else
                lock (_streamLock)
                {
                    _networkStream?.Dispose();
                    _socket?.Dispose();
                    _socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                }

                using var timeoutCts = new CancellationTokenSource(2000);
                await _socket.ConnectAsync(new UnixDomainSocketEndPoint(_endpoint), timeoutCts.Token).ConfigureAwait(false);
                _networkStream = new NetworkStream(_socket, ownsSocket: false);
                _stream = _networkStream;
#endif

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
                DebugLogger.LogException($"TtyHostClient.Reconnect({_sessionId}) attempt {_reconnectAttempts}", ex);
            }
        }

        if (_reconnectAttempts >= MaxReconnectAttempts)
        {
            Log("Max reconnect attempts reached, giving up");
            DebugLogger.LogError($"TtyHostClient.Reconnect({_sessionId})", $"Max reconnect attempts ({MaxReconnectAttempts}) reached, giving up");
            OnStateChanged?.Invoke(_sessionId);
        }
    }

    private async Task<(TtyHostMessageType type, Memory<byte> payload)?> ReadMessageAsync(CancellationToken ct)
    {
        var stream = _stream;
        if (stream is null || !IsConnected) return null;

        var headerBuffer = new byte[TtyHostProtocol.HeaderSize];
        var bytesRead = await stream.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
        if (bytesRead == 0) return null;

        while (bytesRead < TtyHostProtocol.HeaderSize)
        {
            var more = await stream.ReadAsync(headerBuffer.AsMemory(bytesRead), ct).ConfigureAwait(false);
            if (more == 0) return null;
            bytesRead += more;
        }

        if (!TtyHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
        {
            return null;
        }

        var payload = new byte[payloadLength];
        if (payloadLength > 0)
        {
            var totalRead = 0;
            while (totalRead < payloadLength)
            {
                var chunk = await stream.ReadAsync(payload.AsMemory(totalRead), ct).ConfigureAwait(false);
                if (chunk == 0) return null;
                totalRead += chunk;
            }
        }

        return (msgType, payload);
    }

    private static void Log(string message)
    {
        Console.WriteLine($"[TtyHostClient] {message}");
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        _intentionalDisconnect = true;

        _cts?.Cancel();

        lock (_responseLock)
        {
            _pendingResponse?.TrySetCanceled();
        }

        if (_readTask is not null)
        {
            try { await _readTask.ConfigureAwait(false); }
            catch (Exception ex) { DebugLogger.LogException($"TtyHostClient.Dispose.ReadTask({_sessionId})", ex); }
        }

        if (_heartbeatTask is not null)
        {
            try { await _heartbeatTask.ConfigureAwait(false); }
            catch (Exception ex) { DebugLogger.LogException($"TtyHostClient.Dispose.HeartbeatTask({_sessionId})", ex); }
        }

        if (_reconnectTask is not null)
        {
            try { await _reconnectTask.ConfigureAwait(false); }
            catch (Exception ex) { DebugLogger.LogException($"TtyHostClient.Dispose.ReconnectTask({_sessionId})", ex); }
        }

        _cts?.Dispose();
        _readCancellation?.Dispose();
        _writeLock.Dispose();
        _requestLock.Dispose();

        lock (_streamLock)
        {
#if WINDOWS
            _pipe?.Dispose();
#else
            _networkStream?.Dispose();
            _socket?.Dispose();
#endif
        }
    }
}
