using System.Net.Sockets;
#if WINDOWS
using System.IO.Pipes;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
#endif
using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Logging;
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
    private readonly int _hostPid;
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

    private const int MaxReconnectAttempts = 10; // Give up after 10 attempts (~2 minutes with exponential backoff)
    private const int InitialReconnectDelayMs = 100;
    private const int MaxReconnectDelayMs = 30000; // Cap at 30s between attempts
    private const int HeartbeatIntervalMs = 5000; // Check connection every 5 seconds
    private const int ReadTimeoutMs = 10000; // 10 seconds - shorter now that we have heartbeat

    public string SessionId => _sessionId;
    public int HostPid => _hostPid;
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
    public event Action<string, ProcessEventPayload>? OnProcessEvent;
    public event Action<string, ForegroundChangePayload>? OnForegroundChanged;

    public TtyHostClient(string sessionId, int hostPid)
    {
        _sessionId = sessionId;
        _hostPid = hostPid;
        _endpoint = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
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
                return true;
            }
            catch (TimeoutException)
            {
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            catch (IOException)
            {
            }
            catch (SocketException)
            {
            }
            catch
            {
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

                // During discovery, mthost may be flooding output - skip those messages
                // and wait for the actual Info response
                const int maxSkip = 1000;
                for (var skip = 0; skip < maxSkip; skip++)
                {
                    var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
                    if (directResponse is null)
                    {
                        break;
                    }

                    var (type, payload) = directResponse.Value;
                    if (type == TtyHostMessageType.Info)
                    {
                        return TtyHostProtocol.ParseInfo(payload.Span);
                    }
                }

                continue;
            }
            catch
            {
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
                Log.Verbose(() => $"[IPC-SEND] {_sessionId}: {BitConverter.ToString(data.ToArray())}");
            }
            var msg = TtyHostProtocol.CreateInputMessage(data.Span);
            await WriteWithLockAsync(msg, ct).ConfigureAwait(false);
        }
        catch
        {
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
            catch
            {
                TriggerReconnect();
            }
        }

        return false;
    }

    public async Task<byte[]?> GetBufferAsync(CancellationToken ct = default)
    {
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (!IsConnected)
            {
                return null;
            }

            try
            {
                var msg = TtyHostProtocol.CreateGetBuffer();
                var response = await SendRequestAsync(msg, TtyHostMessageType.Buffer, ct).ConfigureAwait(false);
                return response;
            }
            catch
            {
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
        catch
        {
            return false;
        }
    }

    public async Task<bool> SetLogLevelAsync(LogSeverity level, CancellationToken ct = default)
    {
        if (!IsConnected) return false;

        try
        {
            var msg = TtyHostProtocol.CreateSetLogLevelMessage(level);
            var response = await SendRequestAsync(msg, TtyHostMessageType.SetLogLevelAck, ct).ConfigureAwait(false);
            return response is not null;
        }
        catch
        {
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
            Log.Exception(ex, $"TtyHostClient.CloseAsync({_sessionId})");
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
                    continue;
                }
                catch (OperationCanceledException) when (readTimeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
                {
                    continue;
                }

                _lastDataReceived = DateTime.UtcNow;
                if (bytesRead == 0)
                {
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
                ProcessMessage(msgType, payload);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (IOException)
            {
                HandleDisconnect();
            }
            catch (SocketException)
            {
                HandleDisconnect();
            }
            catch
            {
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
                    Log.Exception(ex, $"TtyHostClient.OnOutput({_sessionId})");
                }
                break;

            case TtyHostMessageType.StateChange:
                try
                {
                    OnStateChanged?.Invoke(_sessionId);
                }
                catch (Exception ex)
                {
                    Log.Exception(ex, $"TtyHostClient.OnStateChanged({_sessionId})");
                }
                break;

            case TtyHostMessageType.ProcessEvent:
                try
                {
                    var processEvent = TtyHostProtocol.ParseProcessEvent(payload.Span);
                    if (processEvent is not null)
                    {
                        OnProcessEvent?.Invoke(_sessionId, processEvent);
                    }
                }
                catch (Exception ex)
                {
                    Log.Exception(ex, $"TtyHostClient.OnProcessEvent({_sessionId})");
                }
                break;

            case TtyHostMessageType.ForegroundChange:
                try
                {
                    var foregroundChange = TtyHostProtocol.ParseForegroundChange(payload.Span);
                    if (foregroundChange is not null)
                    {
                        OnForegroundChanged?.Invoke(_sessionId, foregroundChange);
                    }
                }
                catch (Exception ex)
                {
                    Log.Exception(ex, $"TtyHostClient.OnForegroundChanged({_sessionId})");
                }
                break;

            case TtyHostMessageType.Buffer:
            case TtyHostMessageType.ResizeAck:
            case TtyHostMessageType.SetNameAck:
            case TtyHostMessageType.SetLogLevelAck:
            case TtyHostMessageType.CloseAck:
            case TtyHostMessageType.Info:
                lock (_responseLock)
                {
                    _pendingResponse?.TrySetResult((msgType, payload.ToArray()));
                }
                break;

            default:
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
                        if (socket.Poll(0, SelectMode.SelectError))
                        {
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
            catch
            {
            }
        }
    }

    private void CancelReadAndReconnect()
    {
        try { _readCancellation?.Cancel(); } catch { }
        HandleDisconnect();
    }

    private void HandleDisconnect()
    {
        if (_disposed || _intentionalDisconnect) return;
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
        var ct = _cts?.Token ?? CancellationToken.None;

        while (!_disposed && !_intentionalDisconnect && !ct.IsCancellationRequested && _reconnectAttempts < MaxReconnectAttempts)
        {
            _reconnectAttempts++;
            var delay = Math.Min(InitialReconnectDelayMs * (1 << _reconnectAttempts), MaxReconnectDelayMs);

            try
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (_disposed || _intentionalDisconnect || ct.IsCancellationRequested) return;

            try
            {
#if WINDOWS
                lock (_streamLock)
                {
                    _pipe?.Dispose();
                    _pipe = new NamedPipeClientStream(".", _endpoint, PipeDirection.InOut, PipeOptions.Asynchronous);
                }

                using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                connectCts.CancelAfter(2000);
                await _pipe.ConnectAsync(connectCts.Token).ConfigureAwait(false);
                _stream = _pipe;
#else
                lock (_streamLock)
                {
                    _networkStream?.Dispose();
                    _socket?.Dispose();
                    _socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                }

                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeoutCts.CancelAfter(2000);
                await _socket.ConnectAsync(new UnixDomainSocketEndPoint(_endpoint), timeoutCts.Token).ConfigureAwait(false);
                _networkStream = new NetworkStream(_socket, ownsSocket: false);
                _stream = _networkStream;
#endif

                var info = await GetInfoAsync(ct).ConfigureAwait(false);
                if (info is not null)
                {
                    _reconnectAttempts = 0;
                    OnReconnected?.Invoke(_sessionId);
                    return;
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
            }
        }

        if (_reconnectAttempts >= MaxReconnectAttempts)
        {
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
            catch (Exception ex) { Log.Exception(ex, $"TtyHostClient.Dispose.ReadTask({_sessionId})"); }
        }

        if (_heartbeatTask is not null)
        {
            try { await _heartbeatTask.ConfigureAwait(false); }
            catch (Exception ex) { Log.Exception(ex, $"TtyHostClient.Dispose.HeartbeatTask({_sessionId})"); }
        }

        if (_reconnectTask is not null)
        {
            try { await _reconnectTask.ConfigureAwait(false); }
            catch (Exception ex) { Log.Exception(ex, $"TtyHostClient.Dispose.ReconnectTask({_sessionId})"); }
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
