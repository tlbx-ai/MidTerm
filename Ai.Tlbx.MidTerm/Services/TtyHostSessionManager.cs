using System.Collections.Concurrent;
using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Ipc;
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
    private readonly string? _runAsUser;
    private bool _disposed;

    public event Action<string, int, int, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;

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

    /// <summary>
    /// Discover and connect to existing mmttyhost sessions.
    /// Kills incompatible or unresponsive processes, cleans up stale endpoints.
    /// </summary>
    public async Task DiscoverExistingSessionsAsync(CancellationToken ct = default)
    {
        Console.WriteLine("[TtyHostSessionManager] Discovering existing sessions...");

        // Step 1: Find all mmttyhost processes and IPC endpoints
        var runningProcesses = GetRunningTtyHostProcesses();
        var existingEndpoints = GetExistingEndpoints();

        Console.WriteLine($"[TtyHostSessionManager] Found {runningProcesses.Count} mmttyhost processes, {existingEndpoints.Count} IPC endpoints");

        // Step 2: Try to connect to each endpoint
        var connectedSessions = new HashSet<string>();
        var orphanedProcessPids = new HashSet<int>(runningProcesses.Keys);

        foreach (var sessionId in existingEndpoints)
        {
            if (ct.IsCancellationRequested) break;
            if (_clients.ContainsKey(sessionId)) continue;

            var result = await TryConnectToSessionAsync(sessionId, ct).ConfigureAwait(false);

            switch (result)
            {
                case DiscoveryResult.Connected connected:
                    connectedSessions.Add(sessionId);
                    if (connected.Pid > 0)
                    {
                        orphanedProcessPids.Remove(connected.Pid);
                    }
                    break;

                case DiscoveryResult.Incompatible incompatible:
                    Console.WriteLine($"[TtyHostSessionManager] Session {sessionId} incompatible (v{incompatible.Version}), killing");
                    KillProcess(incompatible.Pid);
                    orphanedProcessPids.Remove(incompatible.Pid);
                    CleanupEndpoint(sessionId);
                    break;

                case DiscoveryResult.Unresponsive unresponsive:
                    Console.WriteLine($"[TtyHostSessionManager] Session {sessionId} unresponsive, killing");
                    if (unresponsive.Pid > 0)
                    {
                        KillProcess(unresponsive.Pid);
                        orphanedProcessPids.Remove(unresponsive.Pid);
                    }
                    CleanupEndpoint(sessionId);
                    break;

                case DiscoveryResult.NoProcess:
                    Console.WriteLine($"[TtyHostSessionManager] Session {sessionId} has stale endpoint, cleaning up");
                    CleanupEndpoint(sessionId);
                    break;
            }
        }

        // Step 3: Kill any orphaned mmttyhost processes (no matching endpoint or couldn't connect)
        foreach (var pid in orphanedProcessPids)
        {
            Console.WriteLine($"[TtyHostSessionManager] Killing orphaned mmttyhost (PID: {pid})");
            KillProcess(pid);
        }

        Console.WriteLine($"[TtyHostSessionManager] Discovered {_clients.Count} active sessions");
    }

    private async Task<DiscoveryResult> TryConnectToSessionAsync(string sessionId, CancellationToken ct)
    {
        var client = new TtyHostClient(sessionId);

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
                return new DiscoveryResult.Unresponsive(0);
            }

            // Check version compatibility
            if (!IsVersionCompatible(info.TtyHostVersion))
            {
                await client.DisposeAsync().ConfigureAwait(false);
                return new DiscoveryResult.Incompatible(info.Pid, info.TtyHostVersion);
            }

            // Success - register the client
            SubscribeToClient(client);
            client.StartReadLoop();
            _clients[sessionId] = client;
            _sessionCache[sessionId] = info;
            Console.WriteLine($"[TtyHostSessionManager] Reconnected to session {sessionId} (PID: {info.Pid})");

            return new DiscoveryResult.Connected(info.Pid);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to connect to {sessionId}: {ex.Message}");
            DebugLogger.LogException($"TtyHostSessionManager.TryConnect({sessionId})", ex);
            await client.DisposeAsync().ConfigureAwait(false);
            return new DiscoveryResult.Unresponsive(0);
        }
    }

    private bool IsVersionCompatible(string? conHostVersion)
    {
        if (string.IsNullOrEmpty(conHostVersion)) return false;
        if (conHostVersion == _expectedTtyHostVersion) return true;
        if (_minCompatibleVersion is null) return false;

        return UpdateService.CompareVersions(conHostVersion, _minCompatibleVersion) >= 0;
    }

    private static Dictionary<int, string> GetRunningTtyHostProcesses()
    {
        var result = new Dictionary<int, string>();
        var expectedPath = TtyHostSpawner.ExpectedTtyHostPath;

        try
        {
            // Search for both old name (mmttyhost) and new name (mthost)
            var processNames = new[] { "mthost", "mmttyhost" };

            foreach (var processName in processNames)
            {
                foreach (var proc in Process.GetProcessesByName(processName))
                {
                    try
                    {
                        // Only include processes from this mt's installation path
                        var processPath = proc.MainModule?.FileName;
                        if (string.IsNullOrEmpty(processPath))
                        {
                            Console.WriteLine($"[TtyHostSessionManager] Skipping PID {proc.Id}: could not get process path");
                            continue;
                        }

                        if (!string.Equals(processPath, expectedPath, StringComparison.OrdinalIgnoreCase))
                        {
                            Console.WriteLine($"[TtyHostSessionManager] Skipping PID {proc.Id}: path mismatch");
                            Console.WriteLine($"  Expected: {expectedPath}");
                            Console.WriteLine($"  Actual:   {processPath}");
                            continue;
                        }

                        result[proc.Id] = processPath;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[TtyHostSessionManager] Skipping PID {proc.Id}: {ex.Message}");
                    }
                    finally
                    {
                        proc.Dispose();
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSessionManager] Process enumeration failed: {ex.Message}");
        }

        return result;
    }

    private static List<string> GetExistingEndpoints()
    {
        var endpoints = new List<string>();

        try
        {
#if WINDOWS
            var pipeDir = @"\\.\pipe\";
            foreach (var pipePath in Directory.GetFiles(pipeDir))
            {
                var pipeName = Path.GetFileName(pipePath);
                if (pipeName.StartsWith("mt-con-"))
                {
                    endpoints.Add(pipeName.Replace("mt-con-", ""));
                }
            }
#else
            const string socketDir = "/tmp";
            if (Directory.Exists(socketDir))
            {
                foreach (var socketPath in Directory.GetFiles(socketDir, "mt-con-*.sock"))
                {
                    var fileName = Path.GetFileNameWithoutExtension(socketPath);
                    if (fileName.StartsWith("mt-con-"))
                    {
                        endpoints.Add(fileName.Replace("mt-con-", ""));
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

    private static void CleanupEndpoint(string sessionId)
    {
        try
        {
#if WINDOWS
            // Named pipes are automatically cleaned up when the process exits
#else
            var socketPath = $"/tmp/mt-con-{sessionId}.sock";
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
        public sealed record Connected(int Pid) : DiscoveryResult;
        public sealed record Incompatible(int Pid, string? Version) : DiscoveryResult;
        public sealed record Unresponsive(int Pid) : DiscoveryResult;
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

        if (!TtyHostSpawner.SpawnTtyHost(sessionId, shellType, workingDirectory, cols, rows, DebugLogger.Enabled, _runAsUser, out var processId))
        {
            return null;
        }

        // Wait for IPC endpoint to become available
        await Task.Delay(500, ct).ConfigureAwait(false);

        // Connect to the new session
        var client = new TtyHostClient(sessionId);
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
            Console.WriteLine($"[TtyHostSessionManager] Failed to connect to new session {sessionId}, killing orphan process {processId}");
            KillProcess(processId);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        var info = await client.GetInfoAsync(ct).ConfigureAwait(false);
        if (info is null)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to get info for session {sessionId}, killing orphan process {processId}");
            KillProcess(processId);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        // Start read loop after handshake completes (avoids race condition with GetInfoAsync)
        SubscribeToClient(client);
        client.StartReadLoop();
        _clients[sessionId] = client;
        _sessionCache[sessionId] = info;

        Console.WriteLine($"[TtyHostSessionManager] Created session {sessionId}");
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
                CurrentWorkingDirectory = s.CurrentWorkingDirectory,
                Cols = s.Cols,
                Rows = s.Rows,
                ShellType = s.ShellType,
                Name = s.Name,
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
            Console.WriteLine($"[TtyHostSessionManager] GetBuffer: session {sessionId} not in _clients (count: {_clients.Count})");
            return null;
        }

        Console.WriteLine($"[TtyHostSessionManager] GetBuffer: session {sessionId} found, IsConnected={client.IsConnected}");
        return await client.GetBufferAsync(ct).ConfigureAwait(false);
    }

    public async Task<bool> SetSessionNameAsync(string sessionId, string? name, bool isManual = true, CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return false;
        }

        if (_sessionCache.TryGetValue(sessionId, out var info))
        {
            if (isManual)
            {
                info.ManuallyNamed = true;
            }
            else if (info.ManuallyNamed)
            {
                return true;
            }
        }

        var success = await client.SetNameAsync(name, ct).ConfigureAwait(false);

        if (success && info is not null)
        {
            info.Name = name;
            OnStateChanged?.Invoke(sessionId);
            NotifyStateChange();
        }

        return success;
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
            catch (Exception ex) { DebugLogger.LogException("TtyHostSessionManager.NotifyStateChange", ex); }
        }
    }

    private void SubscribeToClient(TtyHostClient client)
    {
        client.OnOutput += (sessionId, cols, rows, data) => OnOutput?.Invoke(sessionId, cols, rows, data);
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
            catch (Exception ex) { DebugLogger.LogException($"TtyHostSessionManager.Dispose({client.SessionId})", ex); }
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
            using var process = System.Diagnostics.Process.GetProcessById(processId);
            process.Kill();
            Console.WriteLine($"[TtyHostSessionManager] Killed orphan process {processId}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[TtyHostSessionManager] Failed to kill process {processId}: {ex.Message}");
            DebugLogger.LogException($"TtyHostSessionManager.KillProcess({processId})", ex);
        }
    }
}
