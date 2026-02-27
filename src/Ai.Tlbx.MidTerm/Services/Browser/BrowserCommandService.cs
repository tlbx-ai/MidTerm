using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Models.Browser;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserCommandService
{
    private readonly ConcurrentDictionary<string, TaskCompletionSource<BrowserWsResult>> _pending = new();
    private volatile Action<BrowserWsMessage>? _commandListener;
    private volatile bool _clientConnected;

    public bool HasConnectedClient => _clientConnected;

    public void SetClientConnected(bool connected)
    {
        _clientConnected = connected;
    }

    public void SetCommandListener(Action<BrowserWsMessage>? listener)
    {
        _commandListener = listener;
    }

    public async Task<BrowserWsResult> ExecuteCommandAsync(BrowserCommandRequest request, CancellationToken ct)
    {
        if (!_clientConnected)
        {
            return new BrowserWsResult
            {
                Success = false,
                Error = "No browser connected. Open the web preview panel in MidTerm to enable browser commands."
            };
        }

        var listener = _commandListener;
        if (listener is null)
        {
            return new BrowserWsResult
            {
                Success = false,
                Error = "No browser WebSocket connected."
            };
        }

        var id = Guid.NewGuid().ToString("N")[..12];
        var tcs = new TaskCompletionSource<BrowserWsResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        var message = new BrowserWsMessage
        {
            Id = id,
            Command = request.Command,
            Selector = request.Selector,
            Value = request.Value,
            MaxDepth = request.MaxDepth,
            TextOnly = request.TextOnly,
            Timeout = request.Timeout
        };

        BrowserLog.Command(request.Command, request.Selector ?? request.Value);

        try
        {
            listener(message);
        }
        catch (Exception ex)
        {
            _pending.TryRemove(id, out _);
            BrowserLog.Error($"Failed to send command: {ex.Message}");
            return new BrowserWsResult
            {
                Success = false,
                Error = $"Failed to send command to browser: {ex.Message}"
            };
        }

        var timeoutSeconds = request.Timeout ?? 10;
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));

        try
        {
            var result = await tcs.Task.WaitAsync(cts.Token);
            BrowserLog.Result(request.Command, result.Success, result.Result ?? result.Error ?? "");
            return result;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            _pending.TryRemove(id, out _);
            BrowserLog.Result(request.Command, false, $"Timed out after {timeoutSeconds}s");
            return new BrowserWsResult
            {
                Success = false,
                Error = $"Command timed out after {timeoutSeconds} seconds."
            };
        }
        catch (OperationCanceledException)
        {
            _pending.TryRemove(id, out _);
            throw;
        }
    }

    public void ReceiveResult(BrowserWsResult result)
    {
        if (_pending.TryRemove(result.Id, out var tcs))
        {
            tcs.TrySetResult(result);
        }
    }

    public void CancelAllPending()
    {
        foreach (var kvp in _pending)
        {
            if (_pending.TryRemove(kvp.Key, out var tcs))
            {
                tcs.TrySetResult(new BrowserWsResult
                {
                    Id = kvp.Key,
                    Success = false,
                    Error = "Browser disconnected."
                });
            }
        }
    }
}
