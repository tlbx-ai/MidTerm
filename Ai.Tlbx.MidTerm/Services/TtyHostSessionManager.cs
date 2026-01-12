using System.Collections.Concurrent;
using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Manages mmttyhost processes. Spawns new sessions, discovers existing ones on startup.
/// </summary>
public sealed class TtyHostSessionManager : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, TtyHostClient> _clients = new();
    private readonly ConcurrentDictionary<string, SessionInfo> _sessionCache = new();
    private readonly ConcurrentDictionary<string, Action> _stateListeners = new();
    private readonly ConcurrentDictionary<string, string> _tempDirectories = new();
    private readonly string? _expectedTtyHostVersion;
    private readonly string? _minCompatibleVersion;
    private string? _runAsUser;
    private bool _disposed;

    public event Action<string, int, int, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;
    public event Action<string>? OnSessionClosed;
    public event Action<string, ProcessEventPayload>? OnProcessEvent;
    public event Action<string, ForegroundChangePayload>? OnForegroundChanged;

    public TtyHostSessionManager(string? expectedVersion = null, string? minCompatibleVersion = null, string? runAsUser = null)
    {
        _expectedTtyHostVersion = expectedVersion ?? TtyHostSpawner.GetTtyHostVersion();
        _minCompatibleVersion = minCompatibleVersion ?? GetMinCompatibleVersionFromManifest();
        _runAsUser = runAsUser;
    }

    private static string? GetMinCompatibleVersionFromManifest()
    {
        try
        {
            using var updateService = new UpdateService();
            return updateService.InstalledManifest.MinCompatiblePty;
        }
        catch
        {
            return null;
        }
    }

    public void UpdateRunAsUser(string? runAsUser)
    {
        _runAsUser = runAsUser;
        Console.WriteLine($"[TtyHostSessionManager] RunAsUser updated to: {runAsUser ?? "(none)"}");
    }

    public async Task SetLogLevelForAllAsync(LogSeverity level, CancellationToken ct = default)
    {
        Log.Info(() => $"Broadcasting log level change to {_clients.Count} sessions: {level}");

        var tasks = _clients.Values
            .Select(client => client.SetLogLevelAsync(level, ct))
            .ToList();

        await Task.WhenAll(tasks).ConfigureAwait(false);
    }

    /// <summary>
    /// Discover and connect to existing mmttyhost sessions.
    /// Kills incompatible or unresponsive processes, cleans up stale endpoints.
    /// </summary>
    public async Task DiscoverExistingSessionsAsync(CancellationToken ct = default)
    {
        Console.WriteLine("[TtyHostSessionManager] Discovering existing sessions...");

        var existingEndpoints = GetExistingEndpoints();
        Console.WriteLine($"[TtyHostSessionManager] Found {existingEndpoints.Count} IPC endpoints");

        foreach (var (sessionId, hostPid) in existingEndpoints)
        {
            if (ct.IsCancellationRequested) break;
            if (_clients.ContainsKey(sessionId)) continue;

            var result = await TryConnectToSessionAsync(sessionId, hostPid, ct).ConfigureAwait(false);

            switch (result)
            {
                case DiscoveryResult.Connected:
                    // Success - session is usable
                    break;

                case DiscoveryResult.Incompatible incompatible:
                    Console.WriteLine($"[TtyHostSessionManager] Session {sessionId} incompatible (v{incompatible.Version}), killing PID {hostPid}");
                    KillProcess(hostPid);
                    CleanupEndpoint(sessionId, hostPid);
                    break;

                case DiscoveryResult.Unresponsive:
                    Console.WriteLine($"[TtyHostSessionManager] Session {sessionId} unresponsive, killing PID {hostPid}");
                    KillProcess(hostPid);
                    CleanupEndpoint(sessionId, hostPid);
                    break;

                case DiscoveryResult.NoProcess:
                    Console.WriteLine($"[TtyHostSessionManager] Session {sessionId} has stale endpoint (PID {hostPid} not running)");
                    CleanupEndpoint(sessionId, hostPid);
                    break;
            }
        }

        Console.WriteLine($"[TtyHostSessionManager] Discovered {_clients.Count} active sessions");
    }

    private async Task<DiscoveryResult> TryConnectToSessionAsync(string sessionId, int hostPid, CancellationToken ct)
    {
        var client = new TtyHostClient(sessionId, hostPid);

        try
        {
            // Short timeout for discovery - don't wait forever
            if (!await client.ConnectAsync(1500, ct).ConfigureAwait(false))
            {
                await client.DisposeAsync().ConfigureAwait(false);
                return new DiscoveryResult.NoProcess();
            }

            var info = await client.GetInfoAsync(ct).ConfigureAwait(false);
            if (info is null)
            {
                await client.DisposeAsync().ConfigureAwait(false);
                return new DiscoveryResult.Unresponsive();
            }

            // Check version compatibility
            if (!IsVersionCompatible(info.TtyHostVersion))
            {
                await client.DisposeAsync().ConfigureAwait(false);
                return new DiscoveryResult.Incompatible(hostPid, info.TtyHostVersion);
            }

            // Success - register the client
            SubscribeToClient(client);
            client.StartReadLoop();
            _clients[sessionId] = client;
            _sessionCache[sessionId] = info;
            Console.WriteLine($"[TtyHostSessionManager] Reconnected to session {sessionId} (PID {hostPid})");

            return new DiscoveryResult.Connected();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to connect to {sessionId}: {ex.Message}");
            Log.Exception(ex, $"TtyHostSessionManager.TryConnect({sessionId})");
            await client.DisposeAsync().ConfigureAwait(false);
            return new DiscoveryResult.Unresponsive();
        }
    }

    private bool IsVersionCompatible(string? conHostVersion)
    {
        if (string.IsNullOrEmpty(conHostVersion)) return false;
        if (conHostVersion == _expectedTtyHostVersion) return true;
        if (_minCompatibleVersion is null) return false;

        return UpdateService.CompareVersions(conHostVersion, _minCompatibleVersion) >= 0;
    }
    private static List<(string sessionId, int hostPid)> GetExistingEndpoints()
    {
        var endpoints = new List<(string, int)>();

        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            foreach (var pipePath in Directory.GetFiles(pipeDir))
            {
                var pipeName = Path.GetFileName(pipePath);
                var parsed = IpcEndpoint.ParseEndpoint(pipeName);
                if (parsed.HasValue)
                {
                    endpoints.Add(parsed.Value);
                }
            }
#else
            const string socketDir = "/tmp";
            if (Directory.Exists(socketDir))
            {
                foreach (var socketPath in Directory.GetFiles(socketDir, $"{IpcEndpoint.Prefix}*.sock"))
                {
                    var parsed = IpcEndpoint.ParseEndpoint(socketPath);
                    if (parsed.HasValue)
                    {
                        endpoints.Add(parsed.Value);
                    }
                }
            }
#endif
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSessionManager] Endpoint enumeration failed: {ex.Message}");
        }

        return endpoints;
    }

    private static void CleanupEndpoint(string sessionId, int hostPid)
    {
        try
        {
#if WINDOWS
            // Named pipes are automatically cleaned up when the process exits
#else
            var socketPath = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
            if (File.Exists(socketPath))
            {
                File.Delete(socketPath);
                Console.WriteLine($"[TtyHostSessionManager] Removed stale socket: {socketPath}");
            }
#endif
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to cleanup endpoint {sessionId}: {ex.Message}");
        }
    }

    private abstract record DiscoveryResult
    {
        public sealed record Connected() : DiscoveryResult;
        public sealed record Incompatible(int HostPid, string? Version) : DiscoveryResult;
        public sealed record Unresponsive() : DiscoveryResult;
        public sealed record NoProcess() : DiscoveryResult;
    }

    public async Task<SessionInfo?> CreateSessionAsync(
        string? shellType,
        int cols,
        int rows,
        string? workingDirectory,
        CancellationToken ct = default)
    {
        var sessionId = Guid.NewGuid().ToString("N")[..8];

        if (!TtyHostSpawner.SpawnTtyHost(sessionId, shellType, workingDirectory, cols, rows, _runAsUser, out var hostPid))
        {
            return null;
        }

        // Wait for IPC endpoint to become available
        await Task.Delay(500, ct).ConfigureAwait(false);

        // Connect to the new session using sessionId + PID for endpoint
        var client = new TtyHostClient(sessionId, hostPid);
        var connected = false;

        for (var attempt = 0; attempt < 10 && !connected; attempt++)
        {
            connected = await client.ConnectAsync(1000, ct).ConfigureAwait(false);
            if (!connected)
            {
                await Task.Delay(200, ct).ConfigureAwait(false);
            }
        }

        if (!connected)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to connect to new session {sessionId}, killing orphan process {hostPid}");
            KillProcess(hostPid);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        var info = await client.GetInfoAsync(ct).ConfigureAwait(false);
        if (info is null)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to get info for session {sessionId}, killing orphan process {hostPid}");
            KillProcess(hostPid);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        // Start read loop after handshake completes (avoids race condition with GetInfoAsync)
        SubscribeToClient(client);
        client.StartReadLoop();
        _clients[sessionId] = client;
        _sessionCache[sessionId] = info;

        // Send current log level to new session
        await client.SetLogLevelAsync(Log.MinLevel, ct).ConfigureAwait(false);

        Console.WriteLine($"[TtyHostSessionManager] Created session {sessionId} (PID {hostPid})");
        OnStateChanged?.Invoke(sessionId);
        NotifyStateChange();

        return info;
    }

    public SessionInfo? GetSession(string sessionId)
    {
        return _sessionCache.TryGetValue(sessionId, out var info) ? info : null;
    }

    /// <summary>
    /// Get or create the temp directory for file uploads for a session.
    /// </summary>
    public string GetTempDirectory(string sessionId)
    {
        return _tempDirectories.GetOrAdd(sessionId, id =>
        {
            var tempPath = Path.Combine(Path.GetTempPath(), "mt-drops", id);
            Directory.CreateDirectory(tempPath);
            return tempPath;
        });
    }

    private void CleanupTempDirectory(string sessionId)
    {
        if (_tempDirectories.TryRemove(sessionId, out var tempPath))
        {
            try
            {
                if (Directory.Exists(tempPath))
                {
                    Directory.Delete(tempPath, recursive: true);
                }
            }
            catch
            {
                // Best effort cleanup - files may be locked
            }
        }
    }

    public IReadOnlyList<SessionInfo> GetAllSessions()
    {
        return _sessionCache.Values.ToList();
    }

    public SessionListDto GetSessionList()
    {
        return new SessionListDto
        {
            Sessions = _sessionCache.Values.Select(s => new SessionInfoDto
            {
                Id = s.Id,
                Pid = s.Pid,
                CreatedAt = s.CreatedAt,
                IsRunning = s.IsRunning,
                ExitCode = s.ExitCode,
                Cols = s.Cols,
                Rows = s.Rows,
                ShellType = s.ShellType,
                Name = s.Name,
                TerminalTitle = s.TerminalTitle,
                ManuallyNamed = s.ManuallyNamed
            }).OrderBy(s => s.CreatedAt).ToList()
        };
    }

    public async Task<bool> CloseSessionAsync(string sessionId, CancellationToken ct = default)
    {
        if (!_clients.TryRemove(sessionId, out var client))
        {
            return false;
        }

        _sessionCache.TryRemove(sessionId, out _);
        CleanupTempDirectory(sessionId);

        await client.CloseAsync(ct).ConfigureAwait(false);
        await client.DisposeAsync().ConfigureAwait(false);

        OnSessionClosed?.Invoke(sessionId);
        OnStateChanged?.Invoke(sessionId);
        NotifyStateChange();
        return true;
    }

    public async Task<bool> ResizeSessionAsync(string sessionId, int cols, int rows, CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return false;
        }

        var success = await client.ResizeAsync(cols, rows, ct).ConfigureAwait(false);

        if (success && _sessionCache.TryGetValue(sessionId, out var info))
        {
            info.Cols = cols;
            info.Rows = rows;
            OnStateChanged?.Invoke(sessionId);
            NotifyStateChange();
        }

        return success;
    }

    public async Task SendInputAsync(string sessionId, ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        if (_clients.TryGetValue(sessionId, out var client))
        {
            await client.SendInputAsync(data, ct).ConfigureAwait(false);
        }
    }

    public async Task<byte[]?> GetBufferAsync(string sessionId, CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return null;
        }

        return await client.GetBufferAsync(ct).ConfigureAwait(false);
    }

    public async Task<bool> SetSessionNameAsync(string sessionId, string? name, bool isManual = true, CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return false;
        }

        if (!_sessionCache.TryGetValue(sessionId, out var info))
        {
            return false;
        }

        if (isManual)
        {
            // User-set name: store in Name field and send to mthost
            info.ManuallyNamed = !string.IsNullOrWhiteSpace(name);
            var success = await client.SetNameAsync(name, ct).ConfigureAwait(false);
            if (success)
            {
                info.Name = string.IsNullOrWhiteSpace(name) ? null : name;
                OnStateChanged?.Invoke(sessionId);
                NotifyStateChange();
            }
            return success;
        }
        else
        {
            // Terminal-reported title: store in TerminalTitle field (local only, no IPC)
            info.TerminalTitle = string.IsNullOrWhiteSpace(name) ? null : name;
            OnStateChanged?.Invoke(sessionId);
            NotifyStateChange();
            return true;
        }
    }

    public string AddStateListener(Action callback)
    {
        var id = Guid.NewGuid().ToString("N");
        _stateListeners[id] = callback;
        return id;
    }

    public void RemoveStateListener(string id)
    {
        _stateListeners.TryRemove(id, out _);
    }

    private void NotifyStateChange()
    {
        foreach (var listener in _stateListeners.Values)
        {
            try { listener(); }
            catch (Exception ex) { Log.Exception(ex, "TtyHostSessionManager.NotifyStateChange"); }
        }
    }

    private void SubscribeToClient(TtyHostClient client)
    {
        client.OnOutput += (sessionId, cols, rows, data) => OnOutput?.Invoke(sessionId, cols, rows, data);
        client.OnProcessEvent += (sessionId, payload) => OnProcessEvent?.Invoke(sessionId, payload);
        client.OnForegroundChanged += (sessionId, payload) => OnForegroundChanged?.Invoke(sessionId, payload);
        client.OnStateChanged += async sessionId =>
        {
            // Update cached info
            if (_clients.TryGetValue(sessionId, out var c))
            {
                var info = await c.GetInfoAsync().ConfigureAwait(false);
                if (info is not null)
                {
                    _sessionCache[sessionId] = info;
                }

                if (info is null || !info.IsRunning)
                {
                    // Session ended - clean up
                    if (_clients.TryRemove(sessionId, out var removed))
                    {
                        await removed.DisposeAsync().ConfigureAwait(false);
                    }
                    _sessionCache.TryRemove(sessionId, out _);
                }
            }

            OnStateChanged?.Invoke(sessionId);
            NotifyStateChange();
        };
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;

        foreach (var client in _clients.Values)
        {
            try { await client.DisposeAsync().ConfigureAwait(false); }
            catch (Exception ex) { Log.Exception(ex, $"TtyHostSessionManager.Dispose({client.SessionId})"); }
        }

        // Clean up all temp directories
        foreach (var sessionId in _tempDirectories.Keys.ToList())
        {
            CleanupTempDirectory(sessionId);
        }

        _clients.Clear();
        _sessionCache.Clear();
        _stateListeners.Clear();
    }

    private static void KillProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            process.Kill();
        }
        catch
        {
            // Process may have already exited
        }
    }
}
