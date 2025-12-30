using System.Collections.Concurrent;
using System.Text;
using Ai.Tlbx.MiddleManager.Ipc;

namespace Ai.Tlbx.MiddleManager.Services;

public sealed class SidecarClient : IAsyncDisposable
{
    private const int PingTimeoutMs = 15_000;
    private const int ReadTimeoutMs = 10_000;
    private const int ReconnectInitialDelayMs = 100;
    private const int ReconnectMaxDelayMs = 5_000;

    private readonly SemaphoreSlim _connectLock = new(1, 1);
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<IpcFrame>> _pendingRequests = new();
    private IIpcTransport? _transport;
    private CancellationTokenSource? _readCts;
    private CancellationTokenSource? _reconnectCts;
    private bool _disposed;
    private int _connected;
    private long _lastPingTicks;
    private bool _autoReconnect;

    public event Action<string, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<SessionSnapshot>? OnStateChanged;
    public event Action? OnDisconnected;
    public event Action? OnReconnected;

    public bool IsConnected => _connected == 1 && _transport?.IsConnected == true;

    public bool IsHealthy
    {
        get
        {
            if (!IsConnected)
            {
                return false;
            }
            var elapsed = DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastPingTicks);
            return TimeSpan.FromTicks(elapsed).TotalMilliseconds <= PingTimeoutMs;
        }
    }

    // Diagnostic properties for machine room
    public string TransportType => _transport?.GetType().Name ?? "None";
    public string Endpoint => OperatingSystem.IsWindows()
        ? @"\\.\pipe\MiddleManager"
        : "/tmp/middlemanager.sock";
    public long? LastHeartbeatAgoMs => _lastPingTicks > 0
        ? (DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastPingTicks)) / TimeSpan.TicksPerMillisecond
        : null;

    public async Task<bool> ConnectAsync(CancellationToken cancellationToken = default)
    {
        return await ConnectInternalAsync(false, cancellationToken).ConfigureAwait(false);
    }

    public async Task<bool> ConnectWithAutoReconnectAsync(CancellationToken cancellationToken = default)
    {
        return await ConnectInternalAsync(true, cancellationToken).ConfigureAwait(false);
    }

    private async Task<bool> ConnectInternalAsync(bool autoReconnect, CancellationToken cancellationToken)
    {
        if (_disposed)
        {
            return false;
        }

        await _connectLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (IsConnected)
            {
                return true;
            }

            await DisconnectInternalAsync().ConfigureAwait(false);

            _transport = IpcTransportFactory.CreateClient();
            await _transport.ConnectAsync(cancellationToken).ConfigureAwait(false);

            var handshakePayload = SidecarProtocol.CreateHandshakePayload(string.Empty);
            await _transport.WriteFrameAsync(
                new IpcFrame(IpcMessageType.Handshake, string.Empty, handshakePayload),
                cancellationToken).ConfigureAwait(false);

            var response = await _transport.ReadFrameAsync(cancellationToken).ConfigureAwait(false);
            if (response?.Type == IpcMessageType.Error)
            {
                var error = SidecarProtocol.ParseErrorPayload(response.Value.Payload.Span);
                throw new InvalidOperationException($"Handshake failed: {error}");
            }

            if (response?.Type != IpcMessageType.HandshakeAck)
            {
                throw new InvalidOperationException("Invalid handshake response");
            }

            _autoReconnect = autoReconnect;
            Interlocked.Exchange(ref _lastPingTicks, DateTime.UtcNow.Ticks);
            Interlocked.Exchange(ref _connected, 1);

            _readCts = new CancellationTokenSource();
            _ = ReadLoopAsync(_readCts.Token);

            return true;
        }
        catch
        {
            await DisconnectInternalAsync().ConfigureAwait(false);
            return false;
        }
        finally
        {
            _connectLock.Release();
        }
    }

    private async Task ReadLoopAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested && _transport?.IsConnected == true)
            {
                var elapsed = DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastPingTicks);
                if (TimeSpan.FromTicks(elapsed).TotalMilliseconds > PingTimeoutMs)
                {
                    Console.WriteLine("Host heartbeat timeout, disconnecting");
                    break;
                }

                IpcFrame? frame;
                try
                {
                    using var readCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    readCts.CancelAfter(ReadTimeoutMs);
                    frame = await _transport.ReadFrameAsync(readCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    continue;
                }

                if (frame is null)
                {
                    break;
                }

                await HandleFrameAsync(frame.Value).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch
        {
        }
        finally
        {
            var wasConnected = Interlocked.Exchange(ref _connected, 0) == 1;
            if (wasConnected)
            {
                OnDisconnected?.Invoke();

                if (_autoReconnect && !_disposed)
                {
                    _ = ReconnectLoopAsync();
                }
            }
        }
    }

    private async Task ReconnectLoopAsync()
    {
        _reconnectCts?.Cancel();
        _reconnectCts = new CancellationTokenSource();
        var token = _reconnectCts.Token;
        var delay = ReconnectInitialDelayMs;

        Console.WriteLine("Starting reconnection loop...");

        while (!token.IsCancellationRequested && !_disposed)
        {
            try
            {
                await Task.Delay(delay, token).ConfigureAwait(false);

                if (await ConnectInternalAsync(true, token).ConfigureAwait(false))
                {
                    Console.WriteLine("Reconnected to mm-host");
                    OnReconnected?.Invoke();
                    return;
                }

                delay = Math.Min(delay * 2, ReconnectMaxDelayMs);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                delay = Math.Min(delay * 2, ReconnectMaxDelayMs);
            }
        }
    }

    private async Task HandleFrameAsync(IpcFrame frame)
    {
        switch (frame.Type)
        {
            case IpcMessageType.Output:
                OnOutput?.Invoke(frame.SessionId, frame.Payload);
                break;

            case IpcMessageType.StateChange:
                var snapshot = SidecarProtocol.ParseStateChangePayload(frame.Payload.Span);
                OnStateChanged?.Invoke(snapshot);
                break;

            case IpcMessageType.SessionCreated:
            case IpcMessageType.SessionList:
            case IpcMessageType.Buffer:
            case IpcMessageType.Error:
                if (_pendingRequests.TryRemove(frame.SessionId, out var tcs))
                {
                    tcs.TrySetResult(frame);
                }
                else if (_pendingRequests.TryRemove(string.Empty, out tcs))
                {
                    tcs.TrySetResult(frame);
                }
                break;

            case IpcMessageType.Ping:
                Interlocked.Exchange(ref _lastPingTicks, DateTime.UtcNow.Ticks);
                await WriteFrameAsync(new IpcFrame(IpcMessageType.Pong)).ConfigureAwait(false);
                break;

            case IpcMessageType.Pong:
                break;
        }
    }

    private async Task WriteFrameAsync(IpcFrame frame)
    {
        if (_transport is null || !_transport.IsConnected)
        {
            return;
        }

        await _writeLock.WaitAsync().ConfigureAwait(false);
        try
        {
            await _transport.WriteFrameAsync(frame).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task<SessionSnapshot?> CreateSessionAsync(IpcCreateSessionRequest request, CancellationToken cancellationToken = default)
    {
        if (!IsConnected)
        {
            return null;
        }

        var tcs = new TaskCompletionSource<IpcFrame>();
        var requestId = Guid.NewGuid().ToString("N")[..8];
        _pendingRequests[requestId] = tcs;

        try
        {
            var payload = SidecarProtocol.CreateCreateSessionPayload(request);
            await _transport!.WriteFrameAsync(
                new IpcFrame(IpcMessageType.CreateSession, requestId, payload),
                cancellationToken).ConfigureAwait(false);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(10));

            var response = await tcs.Task.WaitAsync(cts.Token).ConfigureAwait(false);

            if (response.Type == IpcMessageType.Error)
            {
                var error = SidecarProtocol.ParseErrorPayload(response.Payload.Span);
                throw new InvalidOperationException(error);
            }

            return SidecarProtocol.ParseSessionCreatedPayload(response.Payload.Span);
        }
        finally
        {
            _pendingRequests.TryRemove(requestId, out _);
        }
    }

    public async Task CloseSessionAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        if (!IsConnected)
        {
            return;
        }

        await _transport!.WriteFrameAsync(
            new IpcFrame(IpcMessageType.CloseSession, sessionId),
            cancellationToken).ConfigureAwait(false);
    }

    public async Task SendInputAsync(string sessionId, ReadOnlyMemory<byte> data, CancellationToken cancellationToken = default)
    {
        if (!IsConnected)
        {
            return;
        }

        await _transport!.WriteFrameAsync(
            new IpcFrame(IpcMessageType.Input, sessionId, data),
            cancellationToken).ConfigureAwait(false);
    }

    public async Task ResizeAsync(string sessionId, int cols, int rows, CancellationToken cancellationToken = default)
    {
        if (!IsConnected)
        {
            return;
        }

        var payload = SidecarProtocol.CreateResizePayload(cols, rows);
        await _transport!.WriteFrameAsync(
            new IpcFrame(IpcMessageType.Resize, sessionId, payload),
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<List<SessionSnapshot>> ListSessionsAsync(CancellationToken cancellationToken = default)
    {
        if (!IsConnected)
        {
            return [];
        }

        var tcs = new TaskCompletionSource<IpcFrame>();
        _pendingRequests[string.Empty] = tcs;

        try
        {
            await _transport!.WriteFrameAsync(
                new IpcFrame(IpcMessageType.ListSessions),
                cancellationToken).ConfigureAwait(false);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(5));

            var response = await tcs.Task.WaitAsync(cts.Token).ConfigureAwait(false);
            return SidecarProtocol.ParseSessionListPayload(response.Payload.Span);
        }
        finally
        {
            _pendingRequests.TryRemove(string.Empty, out _);
        }
    }

    public async Task<byte[]?> GetBufferAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        if (!IsConnected)
        {
            return null;
        }

        var tcs = new TaskCompletionSource<IpcFrame>();
        _pendingRequests[sessionId] = tcs;

        try
        {
            await _transport!.WriteFrameAsync(
                new IpcFrame(IpcMessageType.GetBuffer, sessionId),
                cancellationToken).ConfigureAwait(false);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(5));

            var response = await tcs.Task.WaitAsync(cts.Token).ConfigureAwait(false);
            return response.Payload.ToArray();
        }
        catch (TimeoutException)
        {
            return null;
        }
        finally
        {
            _pendingRequests.TryRemove(sessionId, out _);
        }
    }

    private async Task DisconnectInternalAsync()
    {
        Interlocked.Exchange(ref _connected, 0);

        if (_readCts is not null)
        {
            try { _readCts.Cancel(); } catch { }
            _readCts.Dispose();
            _readCts = null;
        }

        if (_transport is not null)
        {
            await _transport.DisposeAsync().ConfigureAwait(false);
            _transport = null;
        }

        foreach (var tcs in _pendingRequests.Values)
        {
            tcs.TrySetCanceled();
        }
        _pendingRequests.Clear();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;

        _reconnectCts?.Cancel();
        await DisconnectInternalAsync().ConfigureAwait(false);
        _connectLock.Dispose();
        _writeLock.Dispose();
        _reconnectCts?.Dispose();
    }
}
