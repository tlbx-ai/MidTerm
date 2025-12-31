using System.IO.Pipes;

namespace Ai.Tlbx.MiddleManager.Services;

/// <summary>
/// IPC client for a single mm-con-host process.
/// </summary>
public sealed class ConHostClient : IAsyncDisposable
{
    private readonly string _sessionId;
    private readonly string _pipeName;
    private NamedPipeClientStream? _pipe;
    private CancellationTokenSource? _readCts;
    private Task? _readTask;
    private bool _disposed;

    // For request/response coordination when ReadLoop is running
    private TaskCompletionSource<(ConHostMessageType type, byte[] payload)>? _pendingResponse;
    private readonly object _responseLock = new();

    public string SessionId => _sessionId;
    public bool IsConnected => _pipe?.IsConnected ?? false;

    public event Action<string, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;

    public ConHostClient(string sessionId)
    {
        _sessionId = sessionId;
        _pipeName = ConHostProtocol.GetPipeName(sessionId);
    }

    public async Task<bool> ConnectAsync(int timeoutMs = 5000, CancellationToken ct = default)
    {
        if (_disposed) return false;

        try
        {
            _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            await _pipe.ConnectAsync(timeoutMs, ct).ConfigureAwait(false);
            // Don't start ReadLoopAsync here - wait until after initial handshake (GetInfoAsync)
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ConHostClient] Connect to {_pipeName} failed: {ex.Message}");
            _pipe?.Dispose();
            _pipe = null;
            return false;
        }
    }

    public void StartReadLoop()
    {
        if (_readTask is not null) return;
        _readCts = new CancellationTokenSource();
        _readTask = ReadLoopAsync(_readCts.Token);
    }

    public async Task<SessionInfo?> GetInfoAsync(CancellationToken ct = default)
    {
        if (!IsConnected) return null;

        try
        {
            var request = ConHostProtocol.CreateInfoRequest();
            await _pipe!.WriteAsync(request, ct).ConfigureAwait(false);

            var response = await ReadMessageAsync(ct).ConfigureAwait(false);
            if (response is null) return null;

            var (type, payload) = response.Value;
            if (type != ConHostMessageType.Info) return null;

            return ConHostProtocol.ParseInfo(payload.Span);
        }
        catch
        {
            return null;
        }
    }

    public async Task SendInputAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        if (!IsConnected) return;

        try
        {
            var msg = ConHostProtocol.CreateInputMessage(data.Span);
            await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ConHostClient] SendInput failed: {ex.Message}");
        }
    }

    public async Task<bool> ResizeAsync(int cols, int rows, CancellationToken ct = default)
    {
        if (!IsConnected) return false;

        try
        {
            var msg = ConHostProtocol.CreateResizeMessage(cols, rows);

            if (_readTask is not null)
            {
                var tcs = new TaskCompletionSource<(ConHostMessageType type, byte[] payload)>();
                lock (_responseLock) { _pendingResponse = tcs; }
                await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
                var response = await tcs.Task.WaitAsync(ct).ConfigureAwait(false);
                lock (_responseLock) { _pendingResponse = null; }
                return response.type == ConHostMessageType.ResizeAck;
            }

            await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
            var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
            return directResponse?.type == ConHostMessageType.ResizeAck;
        }
        catch
        {
            return false;
        }
    }

    public async Task<byte[]?> GetBufferAsync(CancellationToken ct = default)
    {
        if (!IsConnected) return null;

        try
        {
            // If ReadLoop is running, use the response routing mechanism
            if (_readTask is not null)
            {
                var tcs = new TaskCompletionSource<(ConHostMessageType type, byte[] payload)>();
                lock (_responseLock)
                {
                    _pendingResponse = tcs;
                }

                var msg = ConHostProtocol.CreateGetBuffer();
                await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);

                var response = await tcs.Task.WaitAsync(ct).ConfigureAwait(false);

                lock (_responseLock)
                {
                    _pendingResponse = null;
                }

                return response.type == ConHostMessageType.Buffer ? response.payload : null;
            }

            // ReadLoop not running, use direct read
            var reqMsg = ConHostProtocol.CreateGetBuffer();
            await _pipe!.WriteAsync(reqMsg, ct).ConfigureAwait(false);

            var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
            if (directResponse is null || directResponse.Value.type != ConHostMessageType.Buffer)
            {
                return null;
            }

            return directResponse.Value.payload.ToArray();
        }
        catch
        {
            return null;
        }
    }

    public async Task<bool> SetNameAsync(string? name, CancellationToken ct = default)
    {
        if (!IsConnected) return false;

        try
        {
            var msg = ConHostProtocol.CreateSetName(name);

            if (_readTask is not null)
            {
                var tcs = new TaskCompletionSource<(ConHostMessageType type, byte[] payload)>();
                lock (_responseLock) { _pendingResponse = tcs; }
                await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
                var response = await tcs.Task.WaitAsync(ct).ConfigureAwait(false);
                lock (_responseLock) { _pendingResponse = null; }
                return response.type == ConHostMessageType.SetNameAck;
            }

            await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
            var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
            return directResponse?.type == ConHostMessageType.SetNameAck;
        }
        catch
        {
            return false;
        }
    }

    public async Task<bool> CloseAsync(CancellationToken ct = default)
    {
        if (!IsConnected) return false;

        try
        {
            var msg = ConHostProtocol.CreateClose();

            if (_readTask is not null)
            {
                var tcs = new TaskCompletionSource<(ConHostMessageType type, byte[] payload)>();
                lock (_responseLock) { _pendingResponse = tcs; }
                await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
                var response = await tcs.Task.WaitAsync(ct).ConfigureAwait(false);
                lock (_responseLock) { _pendingResponse = null; }
                return response.type == ConHostMessageType.CloseAck;
            }

            await _pipe!.WriteAsync(msg, ct).ConfigureAwait(false);
            var directResponse = await ReadMessageAsync(ct).ConfigureAwait(false);
            return directResponse?.type == ConHostMessageType.CloseAck;
        }
        catch
        {
            return false;
        }
    }

    private async Task ReadLoopAsync(CancellationToken ct)
    {
        var headerBuffer = new byte[ConHostProtocol.HeaderSize];
        var payloadBuffer = new byte[ConHostProtocol.MaxPayloadSize];

        while (!ct.IsCancellationRequested && IsConnected)
        {
            try
            {
                var bytesRead = await _pipe!.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
                if (bytesRead == 0) break;

                while (bytesRead < ConHostProtocol.HeaderSize)
                {
                    var more = await _pipe.ReadAsync(headerBuffer.AsMemory(bytesRead), ct).ConfigureAwait(false);
                    if (more == 0) return;
                    bytesRead += more;
                }

                if (!ConHostProtocol.TryReadHeader(headerBuffer, out var msgType, out var payloadLength))
                {
                    break;
                }

                if (payloadLength > 0)
                {
                    var totalRead = 0;
                    while (totalRead < payloadLength)
                    {
                        var chunk = await _pipe.ReadAsync(payloadBuffer.AsMemory(totalRead, payloadLength - totalRead), ct).ConfigureAwait(false);
                        if (chunk == 0) return;
                        totalRead += chunk;
                    }
                }

                var payload = payloadBuffer.AsMemory(0, payloadLength);

                switch (msgType)
                {
                    case ConHostMessageType.Output:
                        OnOutput?.Invoke(_sessionId, payload);
                        break;

                    case ConHostMessageType.StateChange:
                        OnStateChanged?.Invoke(_sessionId);
                        break;

                    // Response messages - route to pending request
                    case ConHostMessageType.Buffer:
                    case ConHostMessageType.ResizeAck:
                    case ConHostMessageType.SetNameAck:
                    case ConHostMessageType.CloseAck:
                        lock (_responseLock)
                        {
                            _pendingResponse?.TrySetResult((msgType, payload.ToArray()));
                        }
                        break;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[ConHostClient] Read error: {ex.Message}");
                break;
            }
        }

        OnStateChanged?.Invoke(_sessionId);
    }

    private async Task<(ConHostMessageType type, Memory<byte> payload)?> ReadMessageAsync(CancellationToken ct)
    {
        if (!IsConnected) return null;

        var headerBuffer = new byte[ConHostProtocol.HeaderSize];
        var bytesRead = await _pipe!.ReadAsync(headerBuffer, ct).ConfigureAwait(false);
        if (bytesRead == 0) return null;

        while (bytesRead < ConHostProtocol.HeaderSize)
        {
            var more = await _pipe.ReadAsync(headerBuffer.AsMemory(bytesRead), ct).ConfigureAwait(false);
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
                var chunk = await _pipe.ReadAsync(payload.AsMemory(totalRead), ct).ConfigureAwait(false);
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

        _readCts?.Cancel();

        if (_readTask is not null)
        {
            try { await _readTask.ConfigureAwait(false); } catch { }
        }

        _readCts?.Dispose();
        _pipe?.Dispose();
    }
}
