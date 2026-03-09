using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Models.Browser;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserCommandService
{
    private readonly ConcurrentDictionary<string, PendingCommand> _pending = new();
    private readonly ConcurrentDictionary<string, BrowserClient> _clients = new();

    public bool HasConnectedClient => !_clients.IsEmpty;

    public int ConnectedClientCount => _clients.Count;

    public void RegisterClient(
        string connectionId,
        string? sessionId,
        string? previewId,
        Action<BrowserWsMessage> listener)
    {
        _clients[connectionId] = new BrowserClient
        {
            ConnectionId = connectionId,
            SessionId = string.IsNullOrWhiteSpace(sessionId) ? null : sessionId,
            PreviewId = string.IsNullOrWhiteSpace(previewId) ? null : previewId,
            Listener = listener,
            ConnectedAtUtc = DateTimeOffset.UtcNow
        };
    }

    public void UnregisterClient(string connectionId)
    {
        if (_clients.TryRemove(connectionId, out var client))
        {
            CancelPendingForClient(client.ConnectionId);
        }
    }

    public async Task<BrowserWsResult> ExecuteCommandAsync(BrowserCommandRequest request, CancellationToken ct)
    {
        if (!TryResolveClient(request, out var client, out var error))
        {
            return new BrowserWsResult
            {
                Success = false,
                Error = error
            };
        }

        var id = Guid.NewGuid().ToString("N")[..12];
        var tcs = new TaskCompletionSource<BrowserWsResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = new PendingCommand
        {
            ConnectionId = client.ConnectionId,
            PreviewId = client.PreviewId,
            CompletionSource = tcs
        };

        var message = new BrowserWsMessage
        {
            Id = id,
            Command = request.Command,
            Selector = request.Selector,
            Value = request.Value,
            MaxDepth = request.MaxDepth,
            TextOnly = request.TextOnly,
            Timeout = request.Timeout,
            SessionId = client.SessionId,
            PreviewId = client.PreviewId
        };

        BrowserLog.Command(request.Command, request.Selector ?? request.Value);

        try
        {
            client.Listener(message);
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
        if (!_pending.TryRemove(result.Id, out var pending))
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(pending.PreviewId)
            && !string.IsNullOrWhiteSpace(result.PreviewId)
            && !string.Equals(pending.PreviewId, result.PreviewId, StringComparison.Ordinal))
        {
            pending.CompletionSource.TrySetResult(new BrowserWsResult
            {
                Id = result.Id,
                Success = false,
                Error = "Browser preview mismatch."
            });
            return;
        }

        pending.CompletionSource.TrySetResult(result);
    }

    public void CancelAllPending()
    {
        foreach (var kvp in _pending)
        {
            if (_pending.TryRemove(kvp.Key, out var pending))
            {
                pending.CompletionSource.TrySetResult(new BrowserWsResult
                {
                    Id = kvp.Key,
                    Success = false,
                    Error = "Browser disconnected."
                });
            }
        }
    }

    private void CancelPendingForClient(string connectionId)
    {
        foreach (var kvp in _pending)
        {
            if (!string.Equals(kvp.Value.ConnectionId, connectionId, StringComparison.Ordinal))
            {
                continue;
            }

            if (_pending.TryRemove(kvp.Key, out var pending))
            {
                pending.CompletionSource.TrySetResult(new BrowserWsResult
                {
                    Id = kvp.Key,
                    Success = false,
                    Error = "Browser disconnected."
                });
            }
        }
    }

    private bool TryResolveClient(
        BrowserCommandRequest request,
        out BrowserClient client,
        out string error)
    {
        error = "";
        client = null!;

        var clients = _clients.Values.ToArray();
        if (clients.Length == 0)
        {
            error = "No browser connected. Open the web preview panel in MidTerm to enable browser commands.";
            return false;
        }

        BrowserClient[] matches;
        if (!string.IsNullOrWhiteSpace(request.PreviewId))
        {
            matches = clients
                .Where(c => string.Equals(c.PreviewId, request.PreviewId, StringComparison.Ordinal))
                .OrderByDescending(c => c.ConnectedAtUtc)
                .ToArray();

            if (matches.Length == 0)
            {
                error = $"No browser preview connected for preview '{request.PreviewId}'.";
                return false;
            }
        }
        else if (!string.IsNullOrWhiteSpace(request.SessionId))
        {
            matches = clients
                .Where(c => string.Equals(c.SessionId, request.SessionId, StringComparison.Ordinal))
                .OrderByDescending(c => c.ConnectedAtUtc)
                .ToArray();

            if (matches.Length == 0)
            {
                error = $"No browser preview connected for session '{request.SessionId}'.";
                return false;
            }
        }
        else
        {
            matches = clients
                .OrderByDescending(c => c.ConnectedAtUtc)
                .ToArray();
        }

        if (matches.Length > 1)
        {
            error = string.IsNullOrWhiteSpace(request.SessionId)
                ? "Multiple browser previews are connected. Re-run the command with --session <id>."
                : $"Multiple browser previews are connected for session '{request.SessionId}'.";
            return false;
        }

        client = matches[0];
        return true;
    }

    private sealed class BrowserClient
    {
        public string ConnectionId { get; init; } = "";
        public string? SessionId { get; init; }
        public string? PreviewId { get; init; }
        public required Action<BrowserWsMessage> Listener { get; init; }
        public DateTimeOffset ConnectedAtUtc { get; init; }
    }

    private sealed class PendingCommand
    {
        public string ConnectionId { get; init; } = "";
        public string? PreviewId { get; init; }
        public required TaskCompletionSource<BrowserWsResult> CompletionSource { get; init; }
    }
}
