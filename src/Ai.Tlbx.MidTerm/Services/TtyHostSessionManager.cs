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
    public const int MaxSessions = 256;

    private readonly ConcurrentDictionary<string, TtyHostClient> _clients = new();
    private readonly ConcurrentDictionary<string, SessionInfo> _sessionCache = new();
    private readonly ConcurrentDictionary<string, Action> _stateListeners = new();
    private readonly ConcurrentDictionary<string, string> _tempDirectories = new();
    private readonly ConcurrentDictionary<string, int> _sessionOrder = new();
    private int _nextOrder;
    private readonly string? _expectedTtyHostVersion;
    private readonly string? _minCompatibleVersion;
    private readonly string _dropsBasePath;
    private string? _runAsUser;
    private bool _disposed;

    public event Action<string, int, int, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;
    public event Action<string>? OnSessionClosed;
    public event Action<string, ProcessEventPayload>? OnProcessEvent;
    public event Action<string, ForegroundChangePayload>? OnForegroundChanged;

    public TtyHostSessionManager(string? expectedVersion = null, string? minCompatibleVersion = null, string? runAsUser = null, bool isServiceMode = false)
    {
        _expectedTtyHostVersion = expectedVersion ?? TtyHostSpawner.GetTtyHostVersion();
        _minCompatibleVersion = minCompatibleVersion ?? GetMinCompatibleVersionFromManifest();
        _runAsUser = runAsUser;
        _dropsBasePath = GetDropsBasePath(isServiceMode);
    }

    private static string GetDropsBasePath(bool isServiceMode)
    {
        if (isServiceMode && OperatingSystem.IsWindows())
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            return Path.Combine(programData, "MidTerm", "drops");
        }
        return Path.Combine(Path.GetTempPath(), "mt-drops");
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
        Log.Info(() => $"TtyHostSessionManager: RunAsUser updated to: {runAsUser ?? "(none)"}");
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
        Log.Info(() => "TtyHostSessionManager: Discovering existing sessions...");

        var existingEndpoints = GetExistingEndpoints();
        Log.Info(() => $"TtyHostSessionManager: Found {existingEndpoints.Count} IPC endpoints");

        var discoveredOrders = new List<int>();

        foreach (var (sessionId, hostPid) in existingEndpoints)
        {
            if (ct.IsCancellationRequested) break;
            if (_clients.ContainsKey(sessionId)) continue;

            var result = await TryConnectToSessionAsync(sessionId, hostPid, ct).ConfigureAwait(false);

            switch (result)
            {
                case DiscoveryResult.Connected connected:
                    discoveredOrders.Add(connected.Order);
                    break;

                case DiscoveryResult.Incompatible incompatible:
                    Log.Warn(() => $"TtyHostSessionManager: Session {sessionId} incompatible (v{incompatible.Version}), killing PID {hostPid}");
                    KillProcess(hostPid);
                    CleanupEndpoint(sessionId, hostPid);
                    break;

                case DiscoveryResult.Unresponsive:
                    Log.Warn(() => $"TtyHostSessionManager: Session {sessionId} unresponsive, killing PID {hostPid}");
                    KillProcess(hostPid);
                    CleanupEndpoint(sessionId, hostPid);
                    break;

                case DiscoveryResult.NoProcess:
                    Log.Warn(() => $"TtyHostSessionManager: Session {sessionId} has stale endpoint (PID {hostPid} not running)");
                    CleanupEndpoint(sessionId, hostPid);
                    break;
            }
        }

        // Set _nextOrder to max discovered + 1 to avoid collisions
        _nextOrder = discoveredOrders.Count > 0 ? discoveredOrders.Max() + 1 : 0;

        Log.Info(() => $"TtyHostSessionManager: Discovered {_clients.Count} active sessions, nextOrder={_nextOrder}");
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

            // Use order from mthost if available, otherwise use discovery sequence
            var order = info.Order;
            _sessionOrder.TryAdd(sessionId, order);
            Log.Info(() => $"TtyHostSessionManager: Reconnected to session {sessionId} (PID {hostPid}, order={order})");

            return new DiscoveryResult.Connected(order);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostSessionManager: Failed to connect to {sessionId}: {ex.Message}");
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
            Log.Warn(() => $"TtyHostSessionManager: Endpoint enumeration failed: {ex.Message}");
        }

        return endpoints;
    }

    private static bool EndpointExists(string sessionId, int hostPid)
    {
        try
        {
#if WINDOWS
            // Named pipes appear in \\.\pipe\ directory - enumerate to check existence
            var pipeName = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
            var pipeDir = @"\\.\pipe\";
            return Directory.GetFiles(pipeDir, pipeName).Length > 0;
#else
            var socketPath = IpcEndpoint.GetSessionEndpoint(sessionId, hostPid);
            return File.Exists(socketPath);
#endif
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Find endpoint by sessionId pattern and return the actual host PID.
    /// Used when spawning via sudo where the returned PID is sudo's PID, not mthost's.
    /// </summary>
    private static int? FindEndpointPid(string sessionId)
    {
        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            var pattern = $"mthost-{sessionId}-*";
            var matches = Directory.GetFiles(pipeDir, pattern);
            if (matches.Length == 0) return null;

            var pipeName = Path.GetFileName(matches[0]);
            var parts = pipeName.Split('-');
            if (parts.Length >= 3 && int.TryParse(parts[2], out var pid))
            {
                return pid;
            }
#else
            var pattern = $"/tmp/mthost-{sessionId}-*.sock";
            var matches = Directory.GetFiles("/tmp", $"mthost-{sessionId}-*.sock");
            if (matches.Length == 0) return null;

            var fileName = Path.GetFileNameWithoutExtension(matches[0]);
            var parts = fileName.Split('-');
            if (parts.Length >= 3 && int.TryParse(parts[2], out var pid))
            {
                return pid;
            }
#endif
        }
        catch
        {
            // Ignore errors during scan
        }
        return null;
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
                Log.Info(() => $"TtyHostSessionManager: Removed stale socket: {socketPath}");
            }
#endif
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"TtyHostSessionManager: Failed to cleanup endpoint {sessionId}: {ex.Message}");
        }
    }

    private abstract record DiscoveryResult
    {
        public sealed record Connected(int Order) : DiscoveryResult;
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
        if (_sessionCache.Count >= MaxSessions)
        {
            Log.Warn(() => $"Session limit reached ({MaxSessions})");
            return null;
        }

        var sessionId = Guid.NewGuid().ToString("N")[..8];

        if (!TtyHostSpawner.SpawnTtyHost(sessionId, shellType, workingDirectory, cols, rows, _runAsUser, out var hostPid))
        {
            return null;
        }

        // Wait for IPC endpoint with exponential backoff
        // When using sudo -u, the returned PID is sudo's PID, not mthost's.
        // So we scan for any socket matching the sessionId pattern.
        await Task.Delay(50, ct).ConfigureAwait(false);
        int? actualPid = null;
        for (var wait = 50; wait < 500; wait *= 2)
        {
            // First try exact PID (direct spawn without sudo)
            if (EndpointExists(sessionId, hostPid))
            {
                actualPid = hostPid;
                break;
            }
            // Then scan for any matching socket (sudo spawn case)
            actualPid = FindEndpointPid(sessionId);
            if (actualPid is not null) break;
            await Task.Delay(wait, ct).ConfigureAwait(false);
        }

        // Use actual PID if found via scan, otherwise fall back to spawner PID
        var connectPid = actualPid ?? hostPid;

        // Connect to the new session using sessionId + actual PID for endpoint
        var client = new TtyHostClient(sessionId, connectPid);
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
            Log.Error(() => $"TtyHostSessionManager: Failed to connect to new session {sessionId}, killing orphan process {connectPid}");
            KillProcess(connectPid);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        var info = await client.GetInfoAsync(ct).ConfigureAwait(false);
        if (info is null)
        {
            Log.Error(() => $"TtyHostSessionManager: Failed to get info for session {sessionId}, killing orphan process {connectPid}");
            KillProcess(connectPid);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        // Start read loop after handshake completes (avoids race condition with GetInfoAsync)
        SubscribeToClient(client);
        client.StartReadLoop();
        _clients[sessionId] = client;
        _sessionCache[sessionId] = info;

        var order = Interlocked.Increment(ref _nextOrder);
        _sessionOrder[sessionId] = order;

        // Send current log level and order to new session
        await client.SetLogLevelAsync(Log.MinLevel, ct).ConfigureAwait(false);
        await client.SetOrderAsync((byte)(order % 256), ct).ConfigureAwait(false);

        Log.Info(() => $"TtyHostSessionManager: Created session {sessionId} (PID {connectPid})");
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
            var tempPath = Path.Combine(_dropsBasePath, id);
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
                ManuallyNamed = s.ManuallyNamed,
                CurrentDirectory = s.CurrentDirectory,
                ForegroundPid = s.ForegroundPid,
                ForegroundName = s.ForegroundName,
                ForegroundCommandLine = s.ForegroundCommandLine,
                Order = _sessionOrder.TryGetValue(s.Id, out var order) ? order : int.MaxValue
            }).OrderBy(s => s.Order).ToList()
        };
    }

    public async Task<bool> CloseSessionAsync(string sessionId, CancellationToken ct = default)
    {
        if (!_clients.TryRemove(sessionId, out var client))
        {
            return false;
        }

        _sessionCache.TryRemove(sessionId, out _);
        _sessionOrder.TryRemove(sessionId, out _);
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

    public bool ReorderSessions(IList<string> sessionIds)
    {
        // Validate all sessions exist
        foreach (var id in sessionIds)
        {
            if (!_sessionCache.ContainsKey(id))
            {
                return false;
            }
        }

        // Update local state immediately (UI responsiveness)
        for (var i = 0; i < sessionIds.Count; i++)
        {
            _sessionOrder[sessionIds[i]] = i;
        }

        NotifyStateChange();

        // Fire-and-forget IPC to persist order on mthosts
        _ = SendOrderUpdatesAsync(sessionIds);

        return true;
    }

    private async Task SendOrderUpdatesAsync(IList<string> sessionIds)
    {
        for (var i = 0; i < sessionIds.Count; i++)
        {
            var id = sessionIds[i];
            if (_clients.TryGetValue(id, out var client))
            {
                try
                {
                    await client.SetOrderAsync((byte)i).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    Log.Warn(() => $"Failed to persist order for {id}: {ex.Message}");
                }
            }
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
        client.OnOutput += HandleClientOutput;
        client.OnProcessEvent += HandleClientProcessEvent;
        client.OnForegroundChanged += HandleClientForegroundChanged;
        client.OnStateChanged += HandleClientStateChanged;
    }

    private void HandleClientOutput(string sessionId, int cols, int rows, ReadOnlyMemory<byte> data)
    {
        OnOutput?.Invoke(sessionId, cols, rows, data);
    }

    private void HandleClientProcessEvent(string sessionId, ProcessEventPayload payload)
    {
        OnProcessEvent?.Invoke(sessionId, payload);
    }

    private void HandleClientForegroundChanged(string sessionId, ForegroundChangePayload payload)
    {
        if (_sessionCache.TryGetValue(sessionId, out var info))
        {
            info.ForegroundPid = payload.Pid;
            info.ForegroundName = payload.Name;
            info.ForegroundCommandLine = payload.CommandLine;
            info.CurrentDirectory = payload.Cwd;
        }
        OnForegroundChanged?.Invoke(sessionId, payload);
    }

    private async void HandleClientStateChanged(string sessionId)
    {
        if (_clients.TryGetValue(sessionId, out var c))
        {
            var info = await c.GetInfoAsync().ConfigureAwait(false);
            if (info is not null)
            {
                if (_sessionCache.TryGetValue(sessionId, out var existing))
                {
                    info.TerminalTitle = existing.TerminalTitle;
                    info.ManuallyNamed = existing.ManuallyNamed;
                }
                _sessionCache[sessionId] = info;
            }

            if (info is null || !info.IsRunning)
            {
                if (_clients.TryRemove(sessionId, out var removed))
                {
                    await removed.DisposeAsync().ConfigureAwait(false);
                }
                _sessionCache.TryRemove(sessionId, out _);
            }
        }

        OnStateChanged?.Invoke(sessionId);
        NotifyStateChange();
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
