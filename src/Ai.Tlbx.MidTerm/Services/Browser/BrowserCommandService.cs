using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Models.Browser;

namespace Ai.Tlbx.MidTerm.Services.Browser;

public sealed class BrowserCommandService
{
    private readonly Lock _clientGate = new();
    private readonly ConcurrentDictionary<string, PendingCommand> _pending = new();
    private readonly ConcurrentDictionary<string, BrowserClient> _clients = new();
    private readonly MainBrowserService? _mainBrowserService;

    public BrowserCommandService(MainBrowserService? mainBrowserService = null)
    {
        _mainBrowserService = mainBrowserService;
    }

    public bool HasConnectedClient => !_clients.IsEmpty;

    public int ConnectedClientCount => _clients.Count;

    public bool TryRegisterClient(
        string connectionId,
        string? sessionId,
        string? previewName,
        string? previewId,
        Action<BrowserWsMessage> listener,
        string? browserId = null)
    {
        lock (_clientGate)
        {
            if (!string.IsNullOrWhiteSpace(previewId)
                && _clients.Values.Any(c => string.Equals(c.PreviewId, previewId, StringComparison.Ordinal)))
            {
                return false;
            }

            _clients[connectionId] = new BrowserClient
            {
                ConnectionId = connectionId,
                SessionId = string.IsNullOrWhiteSpace(sessionId) ? null : sessionId,
                PreviewName = string.IsNullOrWhiteSpace(previewName) ? null : previewName,
                PreviewId = string.IsNullOrWhiteSpace(previewId) ? null : previewId,
                BrowserId = string.IsNullOrWhiteSpace(browserId) ? null : browserId,
                Listener = listener,
                ConnectedAtUtc = DateTimeOffset.UtcNow
            };
            return true;
        }
    }

    public void UnregisterClient(string connectionId)
    {
        BrowserClient? client = null;
        lock (_clientGate)
        {
            _clients.TryRemove(connectionId, out client);
        }

        if (client is not null)
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
            PreviewName = client.PreviewName,
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

    public string GetStatusText(
        string? targetUrl,
        string? sessionId = null,
        string? previewName = null,
        string? previewId = null)
    {
        var snapshot = GetStatusSnapshot(
            targetUrl,
            sessionId,
            previewName,
            previewId,
            connectedUiClientCount: 0);
        var status = snapshot.Response;

        if (!status.Connected)
        {
            return $"disconnected\n{snapshot.DisconnectedReason ?? "Open the web preview panel in MidTerm to enable browser commands."}\n";
        }

        var clientLabel = snapshot.IsScoped ? "selected" : "default";
        var lines = new List<string>
        {
            "connected",
            $"target: {status.TargetUrl ?? "(none)"}",
            $"clients: {status.ConnectedClientCount}"
        };

        if (status.DefaultClient is { } client)
        {
            lines.Add($"{clientLabel} preview: {client.PreviewId ?? "(anonymous)"}");
            lines.Add($"{clientLabel} preview name: {client.PreviewName ?? "(default)"}");
            lines.Add($"{clientLabel} session: {client.SessionId ?? "(none)"}");
            lines.Add($"{clientLabel} browser: {client.BrowserId ?? "(none)"}");
        }
        else
        {
            lines.Add($"{clientLabel} preview: ambiguous");
        }

        return string.Join('\n', lines) + "\n";
    }

    public BrowserStatusResponse GetStatus(
        string? targetUrl,
        string? sessionId = null,
        string? previewName = null,
        string? previewId = null,
        int connectedUiClientCount = 0)
    {
        return GetStatusSnapshot(
            targetUrl,
            sessionId,
            previewName,
            previewId,
            connectedUiClientCount).Response;
    }

    private BrowserStatusSnapshot GetStatusSnapshot(
        string? targetUrl,
        string? sessionId,
        string? previewName,
        string? previewId,
        int connectedUiClientCount)
    {
        var clients = _clients.Values
            .OrderByDescending(c => c.ConnectedAtUtc)
            .ToArray();

        if (clients.Length == 0)
        {
            return new BrowserStatusSnapshot
            {
                IsScoped = HasStatusScope(sessionId, previewName, previewId),
                DisconnectedReason = "Open the web preview panel in MidTerm to enable browser commands.",
                Response = new BrowserStatusResponse
                {
                    Connected = false,
                    ConnectedClientCount = 0,
                    ConnectedUiClientCount = connectedUiClientCount,
                    TargetUrl = targetUrl
                }
            };
        }

        var matches = FilterClients(clients, sessionId, previewName, previewId);
        if (matches.Length == 0)
        {
            return new BrowserStatusSnapshot
            {
                IsScoped = HasStatusScope(sessionId, previewName, previewId),
                DisconnectedReason = BuildDisconnectedReason(sessionId, previewName, previewId),
                Response = new BrowserStatusResponse
                {
                    Connected = false,
                    ConnectedClientCount = 0,
                    ConnectedUiClientCount = connectedUiClientCount,
                    TargetUrl = targetUrl
                }
            };
        }

        var mainBrowserId = _mainBrowserService?.GetMainBrowserId();
        return new BrowserStatusSnapshot
        {
            IsScoped = HasStatusScope(sessionId, previewName, previewId),
            Response = new BrowserStatusResponse
            {
                Connected = true,
                ConnectedClientCount = matches.Length,
                ConnectedUiClientCount = connectedUiClientCount,
                TargetUrl = targetUrl,
                DefaultClient = TryResolveDefaultClient(matches, out var client)
                    ? CreateClientInfo(client, mainBrowserId)
                    : null,
                Clients = matches
                    .Select(c => CreateClientInfo(c, mainBrowserId))
                    .ToArray()
            }
        };
    }

    private static BrowserClient[] FilterClients(
        BrowserClient[] clients,
        string? sessionId,
        string? previewName,
        string? previewId)
    {
        if (!HasStatusScope(sessionId, previewName, previewId))
        {
            return clients;
        }

        return clients
            .Where(c =>
                (string.IsNullOrWhiteSpace(previewId)
                    || string.Equals(c.PreviewId, previewId, StringComparison.Ordinal))
                && (string.IsNullOrWhiteSpace(sessionId)
                    || string.Equals(c.SessionId, sessionId, StringComparison.Ordinal))
                && (string.IsNullOrWhiteSpace(previewName)
                    || string.Equals(c.PreviewName, previewName, StringComparison.OrdinalIgnoreCase)))
            .ToArray();
    }

    private static bool HasStatusScope(string? sessionId, string? previewName, string? previewId)
    {
        return !string.IsNullOrWhiteSpace(sessionId)
            || !string.IsNullOrWhiteSpace(previewName)
            || !string.IsNullOrWhiteSpace(previewId);
    }

    private static string BuildDisconnectedReason(string? sessionId, string? previewName, string? previewId)
    {
        if (!string.IsNullOrWhiteSpace(previewId))
        {
            return $"No browser preview connected for preview '{previewId}'.";
        }

        if (!string.IsNullOrWhiteSpace(previewName))
        {
            return $"No browser preview connected for preview '{previewName}' in session '{sessionId ?? "(any)"}'.";
        }

        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            return $"No browser preview connected for session '{sessionId}'.";
        }

        return "Open the web preview panel in MidTerm to enable browser commands.";
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
        else if (!string.IsNullOrWhiteSpace(request.SessionId) || !string.IsNullOrWhiteSpace(request.PreviewName))
        {
            matches = clients
                .Where(c =>
                    (string.IsNullOrWhiteSpace(request.SessionId)
                        || string.Equals(c.SessionId, request.SessionId, StringComparison.Ordinal))
                    && (string.IsNullOrWhiteSpace(request.PreviewName)
                        || string.Equals(c.PreviewName, request.PreviewName, StringComparison.OrdinalIgnoreCase)))
                .OrderByDescending(c => c.ConnectedAtUtc)
                .ToArray();

            if (matches.Length == 0)
            {
                error = !string.IsNullOrWhiteSpace(request.PreviewName)
                    ? $"No browser preview connected for preview '{request.PreviewName}' in session '{request.SessionId ?? "(any)"}'."
                    : $"No browser preview connected for session '{request.SessionId}'.";
                return false;
            }
        }
        else
        {
            matches = clients
                .OrderByDescending(c => c.ConnectedAtUtc)
                .ToArray();
        }

        matches = PreferPreviewScoped(matches);
        matches = PreferMainBrowser(matches);

        if (matches.Length > 1)
        {
            if (TryResolveDefaultClient(matches, out client))
            {
                return true;
            }

            error = string.IsNullOrWhiteSpace(request.SessionId)
                ? "Multiple browser previews are connected. Re-run the command with --session <id>."
                : !string.IsNullOrWhiteSpace(request.PreviewName)
                    ? $"Multiple browser previews are connected for preview '{request.PreviewName}' in session '{request.SessionId}'."
                    : $"Multiple browser previews are connected for session '{request.SessionId}'.";
            return false;
        }

        client = matches[0];
        return true;
    }

    private BrowserClient[] PreferPreviewScoped(BrowserClient[] clients)
    {
        var scoped = clients
            .Where(c => !string.IsNullOrWhiteSpace(c.PreviewId))
            .ToArray();
        return scoped.Length > 0 ? scoped : clients;
    }

    private BrowserClient[] PreferMainBrowser(BrowserClient[] clients)
    {
        var mainBrowserId = _mainBrowserService?.GetMainBrowserId();
        if (string.IsNullOrWhiteSpace(mainBrowserId))
        {
            return clients;
        }

        var main = clients
            .Where(c => string.Equals(c.BrowserId, mainBrowserId, StringComparison.Ordinal))
            .ToArray();
        return main.Length > 0 ? main : clients;
    }

    private bool TryResolveDefaultClient(BrowserClient[] clients, out BrowserClient client)
    {
        client = null!;
        if (clients.Length == 0)
        {
            return false;
        }

        var preferred = PreferMainBrowser(PreferPreviewScoped(clients));
        if (preferred.Length == 0)
        {
            return false;
        }

        var distinctBrowserIds = preferred
            .Select(c => c.BrowserId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        if (distinctBrowserIds.Length > 1)
        {
            return false;
        }

        client = preferred
            .OrderByDescending(c => c.ConnectedAtUtc)
            .First();
        return true;
    }

    private static BrowserClientInfo CreateClientInfo(BrowserClient client, string? mainBrowserId)
    {
        return new BrowserClientInfo
        {
            SessionId = client.SessionId,
            PreviewName = client.PreviewName,
            PreviewId = client.PreviewId,
            BrowserId = client.BrowserId,
            ConnectedAtUtc = client.ConnectedAtUtc,
            IsMainBrowser = !string.IsNullOrWhiteSpace(mainBrowserId)
                && string.Equals(client.BrowserId, mainBrowserId, StringComparison.Ordinal)
        };
    }

    private sealed class BrowserClient
    {
        public string ConnectionId { get; init; } = "";
        public string? SessionId { get; init; }
        public string? PreviewName { get; init; }
        public string? PreviewId { get; init; }
        public string? BrowserId { get; init; }
        public required Action<BrowserWsMessage> Listener { get; init; }
        public DateTimeOffset ConnectedAtUtc { get; init; }
    }

    private sealed class PendingCommand
    {
        public string ConnectionId { get; init; } = "";
        public string? PreviewId { get; init; }
        public required TaskCompletionSource<BrowserWsResult> CompletionSource { get; init; }
    }

    private sealed class BrowserStatusSnapshot
    {
        public required BrowserStatusResponse Response { get; init; }
        public string? DisconnectedReason { get; init; }
        public bool IsScoped { get; init; }
    }
}
