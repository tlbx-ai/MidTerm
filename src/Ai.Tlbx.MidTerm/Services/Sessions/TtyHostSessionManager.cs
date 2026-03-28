using System.Collections.Concurrent;
using System.Diagnostics;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models;

using Ai.Tlbx.MidTerm.Services.Updates;
using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Certificates;
using Ai.Tlbx.MidTerm.Models.Files;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Models.System;
using Ai.Tlbx.MidTerm.Services.Hosting;
namespace Ai.Tlbx.MidTerm.Services.Sessions;

/// <summary>
/// Manages mmttyhost processes. Spawns new sessions, discovers existing ones on startup.
/// </summary>
public sealed class TtyHostSessionManager : IAsyncDisposable
{
    public const int MaxSessions = 256;
    private const int SessionIdLength = 8;
    private const string FallbackMinCompatibleVersion = "2.0.0";

    private readonly SessionRegistry _registry;
    private readonly string? _expectedTtyHostVersion;
    private readonly string? _minCompatibleVersion;
    private readonly MidTermInstanceIdentity _instanceIdentity;
    private readonly TtyHostOwnershipRegistry _ownershipRegistry;
    private readonly SessionForegroundProcessService _foregroundProcessService;
    private readonly ConcurrentDictionary<string, TerminalTransportRuntimeState> _transportState = new();
    private string? _runAsUser;
    private string? _runAsUserSid;
    private bool _disposed;
    private int? _mtPort;
    private Func<string>? _generateToken;
    private string? _tmuxBinDir;
    private readonly ConcurrentDictionary<string, TtyHostClient> _clients;
    private readonly ConcurrentDictionary<string, SessionInfo> _sessionCache;
    private ConcurrentDictionary<string, int> _sessionOrder => _registry.SessionOrder;
    private ConcurrentDictionary<string, byte> _tmuxCreatedSessions => _registry.TmuxCreatedSessions;
    private ConcurrentDictionary<string, byte> _tmuxCommandStarted => _registry.TmuxCommandStarted;
    private ConcurrentDictionary<string, byte> _hiddenSessions => _registry.HiddenSessions;
    private ConcurrentDictionary<string, string> _tmuxParentSessions => _registry.TmuxParentSessions;
    private ConcurrentDictionary<string, string> _bookmarkLinks => _registry.BookmarkLinks;
    private int _nextOrder
    {
        get => _registry.NextOrder;
        set => _registry.SetNextOrder(value);
    }

    public event Action<string, ulong, int, int, ReadOnlyMemory<byte>>? OnOutput;
    public event Action<string>? OnStateChanged;
    public event Action<string>? OnSessionClosed;
    public event Action<string, int>? OnSessionCreated;
    public event Action<string, ForegroundChangePayload>? OnForegroundChanged;
    public event Action<string, string>? OnCwdChanged;

    public TtyHostSessionManager(
        string? expectedVersion = null,
        string? minCompatibleVersion = null,
        string? runAsUser = null,
        string? runAsUserSid = null,
        bool isServiceMode = false,
        SessionControlStateService? sessionControlStateService = null,
        MidTermInstanceIdentity? instanceIdentity = null,
        SessionForegroundProcessService? foregroundProcessService = null)
    {
        _registry = new SessionRegistry(isServiceMode, sessionControlStateService);
        _clients = _registry.Clients;
        _sessionCache = _registry.SessionCache;
        _expectedTtyHostVersion = expectedVersion ?? TtyHostSpawner.GetTtyHostVersion();
        _minCompatibleVersion = minCompatibleVersion ?? GetMinCompatibleVersionFromManifest();
        _instanceIdentity = instanceIdentity ?? MidTermInstanceIdentity.Load(
            Path.Combine(Path.GetTempPath(), "midterm-test-instance", Guid.NewGuid().ToString("N")),
            0);
        _ownershipRegistry = new TtyHostOwnershipRegistry(_instanceIdentity.SessionRegistryPath);
        _foregroundProcessService = foregroundProcessService ?? new SessionForegroundProcessService();
        _runAsUser = runAsUser;
        _runAsUserSid = runAsUserSid;
    }

    private static string? GetMinCompatibleVersionFromManifest()
    {
        try
        {
            return UpdateService.ReadInstalledManifest().MinCompatiblePty;
        }
        catch
        {
            // Fallback to permissive minimum to avoid killing sessions when manifest can't be read
            return FallbackMinCompatibleVersion;
        }
    }

    public void UpdateRunAsUser(string? runAsUser, string? runAsUserSid = null)
    {
        _runAsUser = runAsUser;
        _runAsUserSid = runAsUserSid;
        Log.Info(() => $"TtyHostSessionManager: RunAsUser updated to: {runAsUser ?? "(none)"}");
    }

    public void ConfigureTmux(int port, Func<string> generateToken, string? tmuxBinDir)
    {
        _mtPort = port;
        _generateToken = generateToken;
        _tmuxBinDir = tmuxBinDir;
    }

    /// <summary>
    /// Discover and connect to existing mmttyhost sessions.
    /// Kills incompatible or unresponsive processes, cleans up stale endpoints.
    /// </summary>
    public async Task DiscoverExistingSessionsAsync(CancellationToken ct = default)
    {
        Log.Info(() => $"TtyHostSessionManager: Discovering existing sessions for instance {_instanceIdentity.GetShortInstanceId()}...");

        var discoveredOrders = new List<int>();
        var ownedRecords = _ownershipRegistry.GetSessions();

        foreach (var ownedRecord in ownedRecords)
        {
            if (ct.IsCancellationRequested) break;
            if (_registry.Clients.ContainsKey(ownedRecord.SessionId)) continue;

            var result = await TryConnectToSessionAsync(
                ownedRecord.SessionId,
                ownedRecord.HostPid,
                ownedRecord.IsLegacyEndpoint,
                allowLegacyOwnerless: ownedRecord.IsLegacyEndpoint,
                ct).ConfigureAwait(false);

            HandleDiscoveryResult(ownedRecord.SessionId, ownedRecord.HostPid, ownedRecord.IsLegacyEndpoint, result, discoveredOrders);
        }

        var existingEndpoints = SessionEndpointDiscovery.GetExistingEndpoints(_instanceIdentity.InstanceId);
        Log.Info(() => $"TtyHostSessionManager: Found {existingEndpoints.Count} owned IPC endpoints");

        foreach (var (sessionId, hostPid) in existingEndpoints)
        {
            if (ct.IsCancellationRequested) break;
            if (_registry.Clients.ContainsKey(sessionId)) continue;

            var result = await TryConnectToSessionAsync(
                sessionId,
                hostPid,
                isLegacyEndpoint: false,
                allowLegacyOwnerless: false,
                ct).ConfigureAwait(false);
            HandleDiscoveryResult(sessionId, hostPid, legacyEndpoint: false, result, discoveredOrders);
        }

        if (ownedRecords.Count == 0 && _instanceIdentity.CanImportLegacySessions())
        {
            var legacyEndpoints = SessionEndpointDiscovery.GetLegacyEndpoints();
            Log.Info(() => $"TtyHostSessionManager: Importing {legacyEndpoints.Count} legacy IPC endpoints");

            foreach (var (sessionId, hostPid) in legacyEndpoints)
            {
                if (ct.IsCancellationRequested) break;
                if (_registry.Clients.ContainsKey(sessionId)) continue;

                var result = await TryConnectToSessionAsync(
                    sessionId,
                    hostPid,
                    isLegacyEndpoint: true,
                    allowLegacyOwnerless: true,
                    ct).ConfigureAwait(false);
                HandleDiscoveryResult(sessionId, hostPid, legacyEndpoint: true, result, discoveredOrders);
            }

            _instanceIdentity.MarkLegacySessionsImported();
        }

        // Set _nextOrder to max discovered + 1 to avoid collisions
        _registry.SetNextOrder(discoveredOrders.Count > 0 ? discoveredOrders.Max() + 1 : 0);

        Log.Info(() => $"TtyHostSessionManager: Discovered {_registry.ClientCount} active sessions, nextOrder={_registry.NextOrder}");
    }

    private void HandleDiscoveryResult(
        string sessionId,
        int hostPid,
        bool legacyEndpoint,
        DiscoveryResult result,
        List<int> discoveredOrders)
    {
        switch (result)
        {
            case DiscoveryResult.Connected connected:
                discoveredOrders.Add(connected.Order);
                break;

            case DiscoveryResult.Incompatible incompatible:
                Log.Warn(() => $"TtyHostSessionManager: Session {sessionId} incompatible (v{incompatible.Version}), killing PID {hostPid}");
                KillProcess(hostPid);
                SessionEndpointDiscovery.CleanupEndpoint(_instanceIdentity.InstanceId, sessionId, hostPid, legacyEndpoint);
                _ownershipRegistry.Remove(sessionId);
                break;

            case DiscoveryResult.Unresponsive:
                Log.Warn(() => $"TtyHostSessionManager: Session {sessionId} unresponsive, killing PID {hostPid}");
                KillProcess(hostPid);
                SessionEndpointDiscovery.CleanupEndpoint(_instanceIdentity.InstanceId, sessionId, hostPid, legacyEndpoint);
                _ownershipRegistry.Remove(sessionId);
                break;

            case DiscoveryResult.NoProcess:
                Log.Warn(() => $"TtyHostSessionManager: Session {sessionId} has stale endpoint (PID {hostPid} not running)");
                SessionEndpointDiscovery.CleanupEndpoint(_instanceIdentity.InstanceId, sessionId, hostPid, legacyEndpoint);
                _ownershipRegistry.Remove(sessionId);
                break;
        }
    }

    private async Task<DiscoveryResult> TryConnectToSessionAsync(
        string sessionId,
        int hostPid,
        bool isLegacyEndpoint,
        bool allowLegacyOwnerless,
        CancellationToken ct)
    {
        var client = new TtyHostClient(sessionId, hostPid, _instanceIdentity.InstanceId, _instanceIdentity.OwnerToken, useLegacyEndpoint: isLegacyEndpoint);

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

            if (!string.IsNullOrWhiteSpace(info.OwnerInstanceId) &&
                !string.Equals(info.OwnerInstanceId, _instanceIdentity.InstanceId, StringComparison.Ordinal))
            {
                await client.DisposeAsync().ConfigureAwait(false);
                return new DiscoveryResult.Unresponsive();
            }

            if (string.IsNullOrWhiteSpace(info.OwnerInstanceId) && !allowLegacyOwnerless)
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
            _registry.Clients[sessionId] = client;
            _registry.SessionCache[sessionId] = info;
            _transportState.TryAdd(sessionId, new TerminalTransportRuntimeState());
            _ownershipRegistry.Upsert(sessionId, hostPid, isLegacyEndpoint || string.IsNullOrWhiteSpace(info.OwnerInstanceId));

            // Use order from mthost if available, otherwise use discovery sequence
            var order = info.Order;
            _registry.SessionOrder.TryAdd(sessionId, order);
            OnSessionCreated?.Invoke(sessionId, order);
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
        if (_registry.SessionCount >= MaxSessions)
        {
            Log.Warn(() => $"Session limit reached ({MaxSessions})");
            return null;
        }

        var sessionId = Guid.NewGuid().ToString("N")[..SessionIdLength];

        var paneIndex = _registry.ReserveNextOrder();
        var mtToken = _generateToken?.Invoke();
        if (!TtyHostSpawner.SpawnTtyHost(sessionId, shellType, workingDirectory, cols, rows, _instanceIdentity.InstanceId, _instanceIdentity.OwnerToken, _runAsUser, _runAsUserSid, out var hostPid,
                _mtPort, mtToken, paneIndex, _tmuxBinDir))
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
            if (SessionEndpointDiscovery.EndpointExists(_instanceIdentity.InstanceId, sessionId, hostPid))
            {
                actualPid = hostPid;
                break;
            }
            // Then scan for any matching socket (sudo spawn case)
            actualPid = SessionEndpointDiscovery.FindEndpointPid(_instanceIdentity.InstanceId, sessionId);
            if (actualPid is not null) break;
            await Task.Delay(wait, ct).ConfigureAwait(false);
        }

        // Use actual PID if found via scan, otherwise fall back to spawner PID
        var connectPid = actualPid ?? hostPid;

        // Connect to the new session using sessionId + actual PID for endpoint
        var client = new TtyHostClient(sessionId, connectPid, _instanceIdentity.InstanceId, _instanceIdentity.OwnerToken);
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
            TtyHostSpawner.CleanupMacOsGuiLaunchAgent(sessionId);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        var info = await client.GetInfoAsync(ct).ConfigureAwait(false);
        if (info is null)
        {
            Log.Error(() => $"TtyHostSessionManager: Failed to get info for session {sessionId}, killing orphan process {connectPid}");
            KillProcess(connectPid);
            TtyHostSpawner.CleanupMacOsGuiLaunchAgent(sessionId);
            await client.DisposeAsync().ConfigureAwait(false);
            return null;
        }

        info.TerminalTitle = NormalizeTerminalTitle(info, info.TerminalTitle);

        // Start read loop after handshake completes (avoids race condition with GetInfoAsync)
        SubscribeToClient(client);
        client.StartReadLoop();
        _registry.Clients[sessionId] = client;
        _registry.SessionCache[sessionId] = info;
        _transportState[sessionId] = new TerminalTransportRuntimeState();
        _registry.SessionOrder[sessionId] = paneIndex;
        _ownershipRegistry.Upsert(sessionId, connectPid, isLegacyEndpoint: false);

        await client.SetOrderAsync((byte)(paneIndex % 256), ct).ConfigureAwait(false);

        Log.Info(() => $"TtyHostSessionManager: Created session {sessionId} (PID {connectPid})");
        OnSessionCreated?.Invoke(sessionId, paneIndex);
        OnStateChanged?.Invoke(sessionId);
        NotifyStateChange();

        return info;
    }

    public SessionInfo? GetSession(string sessionId)
    {
        return _registry.GetSession(sessionId);
    }

    public void MarkTmuxCreated(string sessionId)
    {
        _registry.MarkTmuxCreated(sessionId);
    }

    public void SetTmuxParent(string childSessionId, string parentSessionId)
    {
        _registry.SetTmuxParent(childSessionId, parentSessionId);
    }

    public async Task<SessionInfo?> GetSessionFreshAsync(string sessionId, CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return null;
        }

        var info = await client.GetInfoAsync(ct).ConfigureAwait(false);
        if (info is not null)
        {
            if (_sessionCache.TryGetValue(sessionId, out var existing))
            {
                MergeCachedFields(info, existing);
            }
            _sessionCache[sessionId] = info;
        }
        return info;
    }

    public async Task<bool> SetClipboardImageAsync(
        string sessionId,
        string filePath,
        string? mimeType,
        CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return false;
        }

        return await client.SetClipboardImageAsync(filePath, mimeType, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Get or create the temp directory for file uploads for a session.
    /// </summary>
    public string GetTempDirectory(string sessionId)
    {
        return _registry.GetTempDirectory(sessionId);
    }

    private void CleanupTempDirectory(string sessionId)
    {
        _registry.CleanupTempDirectory(sessionId);
    }

    public void MarkHidden(string sessionId)
    {
        _registry.MarkHidden(sessionId);
    }

    public bool IsHidden(string sessionId)
    {
        return _registry.IsHidden(sessionId);
    }

    public IReadOnlyList<SessionInfo> GetAllSessions()
    {
        return _registry.GetAllSessions();
    }

    public SessionListDto GetSessionList()
    {
        var response = _registry.GetSessionList();
        foreach (var session in response.Sessions)
        {
            var descriptor = _foregroundProcessService.Describe(
                session.ForegroundName,
                session.ForegroundCommandLine,
                session.AgentAttachPoint);
            session.ForegroundDisplayName = string.IsNullOrWhiteSpace(descriptor.DisplayName) ? null : descriptor.DisplayName;
            session.ForegroundProcessIdentity = string.IsNullOrWhiteSpace(descriptor.ProcessIdentity) ? null : descriptor.ProcessIdentity;
        }

        return response;
    }

    public async Task<bool> CloseSessionAsync(string sessionId, CancellationToken ct = default)
    {
        if (!_clients.TryRemove(sessionId, out var client))
        {
            return false;
        }

        _registry.RemoveSessionState(sessionId);
        _ownershipRegistry.Remove(sessionId);
        _transportState.TryRemove(sessionId, out _);

        await client.CloseAsync(ct).ConfigureAwait(false);
        await client.DisposeAsync().ConfigureAwait(false);
        TtyHostSpawner.CleanupMacOsGuiLaunchAgent(sessionId);

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

    public async Task<byte[]?> PingAsync(string sessionId, byte[] pingData, CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return null;
        }
        return await client.PingAsync(pingData, ct).ConfigureAwait(false);
    }

    public async Task<TtyHostBufferSnapshot?> GetBufferAsync(
        string sessionId,
        int? maxBytes = null,
        TerminalReplayReason reason = TerminalReplayReason.Manual,
        CancellationToken ct = default)
    {
        if (!_clients.TryGetValue(sessionId, out var client))
        {
            return null;
        }

        var snapshot = await client.GetBufferAsync(maxBytes, reason, ct).ConfigureAwait(false);
        if (snapshot is not null)
        {
            var state = _transportState.GetOrAdd(sessionId, static _ => new TerminalTransportRuntimeState());
            state.SourceSeq = snapshot.SequenceStart + (ulong)snapshot.Data.Length;
            state.MuxReceivedSeq = state.SourceSeq;
            state.LastReplayBytes = snapshot.Data.Length;
            state.LastReplayReason = reason;
        }

        return snapshot;
    }

    public TerminalTransportRuntimeSnapshot GetTransportRuntimeSnapshot(string sessionId)
    {
        if (!_transportState.TryGetValue(sessionId, out var state))
        {
            return new TerminalTransportRuntimeSnapshot();
        }

        return state.ToSnapshot();
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
            info.TerminalTitle = NormalizeTerminalTitle(info, name);
            OnStateChanged?.Invoke(sessionId);
            NotifyStateChange();
            return true;
        }
    }

    public bool SetBookmarkId(string sessionId, string bookmarkId)
    {
        return _registry.SetBookmarkId(sessionId, bookmarkId);
    }

    public bool SetAgentControlled(string sessionId, bool agentControlled)
    {
        return _registry.SetAgentControlled(sessionId, agentControlled);
    }

    public bool SetLensOnly(string sessionId, bool lensOnly)
    {
        return _registry.SetLensOnly(sessionId, lensOnly);
    }

    public bool SetProfileHint(string sessionId, string? profile)
    {
        return _registry.SetProfileHint(sessionId, profile);
    }

    public int ClearBookmarksByHistoryId(string bookmarkId)
    {
        return _registry.ClearBookmarksByHistoryId(bookmarkId);
    }

    public bool ReorderSessions(IList<string> sessionIds)
    {
        if (!_registry.ReorderSessions(sessionIds))
        {
            return false;
        }

        _ = SendOrderUpdatesAsync(sessionIds).ContinueWith(
            t => Log.Exception(t.Exception!.InnerException!, "TtyHostSessionManager.SendOrderUpdates"),
            TaskContinuationOptions.OnlyOnFaulted);

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
        return _registry.AddStateListener(callback);
    }

    public void RemoveStateListener(string id)
    {
        _registry.RemoveStateListener(id);
    }

    private void NotifyStateChange()
    {
        _registry.NotifyStateChange();
    }

    private void SubscribeToClient(TtyHostClient client)
    {
        client.OnOutput += HandleClientOutput;
        client.OnForegroundChanged += HandleClientForegroundChanged;
        client.OnStateChanged += id => _ = HandleClientStateChangedAsync(id);
        client.OnReconnected += HandleClientReconnected;
        client.OnDataLoss += HandleClientDataLoss;
    }

    private void HandleClientOutput(string sessionId, ulong sequenceStart, int cols, int rows, ReadOnlyMemory<byte> data)
    {
        var state = _transportState.GetOrAdd(sessionId, static _ => new TerminalTransportRuntimeState());
        state.SourceSeq = sequenceStart + (ulong)data.Length;
        state.MuxReceivedSeq = state.SourceSeq;
        OnOutput?.Invoke(sessionId, sequenceStart, cols, rows, data);
        ScanForOscSequences(sessionId, data.Span);
    }

    private void HandleClientReconnected(string sessionId)
    {
        var state = _transportState.GetOrAdd(sessionId, static _ => new TerminalTransportRuntimeState());
        state.ReconnectCount++;
    }

    private void HandleClientDataLoss(string sessionId, TtyHostDataLossPayload payload)
    {
        var state = _transportState.GetOrAdd(sessionId, static _ => new TerminalTransportRuntimeState());
        state.DataLossCount++;
        state.LastDataLossReason = payload.Reason;
    }

    /// <summary>
    /// Scan terminal output for OSC sequences we care about:
    /// - OSC 0/2: Window title (ESC ] 0 ; title BEL)
    /// - OSC 7: CWD reporting (ESC ] 7 ; file://host/path BEL)
    /// </summary>
    private static ReadOnlySpan<byte> EscOsc => [0x1B, 0x5D];

    private void ScanForOscSequences(string sessionId, ReadOnlySpan<byte> data)
    {
        // Quick check: does the data contain ESC ] at all?
        if (data.IndexOf(EscOsc) < 0) return;

        var pos = 0;
        var changed = false;

        while (pos < data.Length - 2)
        {
            // Find next ESC ]
            var idx = data[pos..].IndexOf(EscOsc);
            if (idx < 0) break;
            idx += pos;

            // Read the OSC number and semicolon
            var numStart = idx + 2;
            if (numStart >= data.Length) break;

            // Parse single-digit OSC number followed by ;
            var oscNum = -1;
            var payloadStart = -1;
            if (numStart + 1 < data.Length && data[numStart] >= (byte)'0' && data[numStart] <= (byte)'9' && data[numStart + 1] == (byte)';')
            {
                oscNum = data[numStart] - '0';
                payloadStart = numStart + 2;
            }

            if (oscNum < 0 || payloadStart >= data.Length)
            {
                pos = numStart;
                continue;
            }

            // Find terminator: BEL (0x07) or ST (ESC \ = 0x1B 0x5C)
            var end = -1;
            for (var i = payloadStart; i < data.Length; i++)
            {
                if (data[i] == 0x07) { end = i; break; }
                if (data[i] == 0x1B && i + 1 < data.Length && data[i + 1] == 0x5C) { end = i; break; }
            }
            if (end <= payloadStart)
            {
                pos = payloadStart;
                continue;
            }

            var payload = System.Text.Encoding.UTF8.GetString(data[payloadStart..end]);

            switch (oscNum)
            {
                case 0:
                case 2:
                    changed |= HandleOscTitle(sessionId, payload);
                    break;
                case 7:
                    changed |= HandleOscCwdUpdate(sessionId, payload);
                    break;
            }

            pos = end + 1;
        }

        if (changed)
        {
            NotifyStateChange();
        }
    }

    private bool HandleOscTitle(string sessionId, string title)
    {
        if (!_sessionCache.TryGetValue(sessionId, out var info)) return false;
        var trimmed = NormalizeTerminalTitle(info, title);
        if (string.Equals(info.TerminalTitle, trimmed, StringComparison.Ordinal)) return false;
        info.TerminalTitle = trimmed;
        return true;
    }

    private static string? NormalizeTerminalTitle(SessionInfo session, string? title)
    {
        var trimmed = string.IsNullOrWhiteSpace(title) ? null : title.Trim();
        if (trimmed is null)
        {
            return null;
        }

        var normalizedTitle = NormalizeExecutableIdentity(trimmed);
        var normalizedShell = NormalizeExecutableIdentity(session.ShellType);
        if (!string.IsNullOrEmpty(normalizedTitle) &&
            !string.IsNullOrEmpty(normalizedShell) &&
            string.Equals(normalizedTitle, normalizedShell, StringComparison.Ordinal))
        {
            return null;
        }

        return trimmed;
    }

    private static string NormalizeExecutableIdentity(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return string.Empty;
        }

        var candidate = value.Trim();
        var firstChar = candidate[0];
        if ((firstChar == '"' || firstChar == '\'') && candidate.Length > 1)
        {
            var closingQuote = candidate.IndexOf(firstChar, 1);
            if (closingQuote > 1)
            {
                candidate = candidate[1..closingQuote];
            }
        }

        candidate = candidate.Replace('\\', '/');
        var basename = candidate.Split('/').LastOrDefault() ?? candidate;
        var token = basename.Trim().Split(' ', '\t').FirstOrDefault() ?? basename.Trim();
        return token.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
            ? token[..^4].ToLowerInvariant()
            : token.ToLowerInvariant();
    }

    private bool HandleOscCwdUpdate(string sessionId, string payload)
    {
        if (!_sessionCache.TryGetValue(sessionId, out var info)) return false;

        if (!payload.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) return false;
        var pathStart = payload.IndexOf('/', 7);
        if (pathStart < 0) return false;

        var path = Uri.UnescapeDataString(payload[pathStart..]);

        // Windows: /C:/foo → C:\foo
        if (path.Length >= 3 && path[0] == '/' && char.IsLetter(path[1]) && path[2] == ':')
        {
            path = path[1..].Replace('/', '\\');
        }

        if (string.IsNullOrWhiteSpace(path)) return false;
        if (string.Equals(info.CurrentDirectory, path, StringComparison.OrdinalIgnoreCase)) return false;
        info.CurrentDirectory = path;
        OnCwdChanged?.Invoke(sessionId, path);
        return true;
    }

    private void HandleClientForegroundChanged(string sessionId, ForegroundChangePayload payload)
    {
        var descriptor = _foregroundProcessService.Describe(payload.Name, payload.CommandLine, payload.AgentAttachPoint);
        payload.DisplayName = string.IsNullOrWhiteSpace(descriptor.DisplayName) ? null : descriptor.DisplayName;
        payload.ProcessIdentity = string.IsNullOrWhiteSpace(descriptor.ProcessIdentity) ? null : descriptor.ProcessIdentity;

        if (_sessionCache.TryGetValue(sessionId, out var info))
        {
            info.ForegroundPid = payload.Pid;
            info.ForegroundName = payload.Name;
            info.ForegroundCommandLine = payload.CommandLine;
            info.AgentAttachPoint = payload.AgentAttachPoint;
            if (!string.IsNullOrEmpty(payload.Cwd))
            {
                info.CurrentDirectory = payload.Cwd;
            }
        }

        if (_tmuxCreatedSessions.ContainsKey(sessionId))
        {
            var shellName = info?.ShellType.ToString();
            var isShellForeground = shellName is not null &&
                string.Equals(payload.Name, shellName, StringComparison.OrdinalIgnoreCase);

            if (!isShellForeground)
            {
                _tmuxCommandStarted.TryAdd(sessionId, 0);
            }
            else if (_tmuxCommandStarted.TryRemove(sessionId, out _))
            {
                _ = CloseSessionAsync(sessionId, CancellationToken.None);
                return;
            }
        }

        OnForegroundChanged?.Invoke(sessionId, payload);
        NotifyStateChange();
    }

    private async Task HandleClientStateChangedAsync(string sessionId)
    {
        try
        {
            if (_clients.TryGetValue(sessionId, out var c))
            {
                var info = await c.GetInfoAsync().ConfigureAwait(false);
                if (info is not null)
                {
                    if (_sessionCache.TryGetValue(sessionId, out var existing))
                    {
                        MergeCachedFields(info, existing);
                    }
                    _sessionCache[sessionId] = info;
                }

                if (info is null || !info.IsRunning)
                {
                    if (_tmuxCreatedSessions.TryRemove(sessionId, out _))
                    {
                        await CloseSessionAsync(sessionId, CancellationToken.None).ConfigureAwait(false);
                        return;
                    }

                    if (_clients.TryRemove(sessionId, out var removed))
                    {
                        await removed.DisposeAsync().ConfigureAwait(false);
                    }
                    _sessionCache.TryRemove(sessionId, out _);
                    _transportState.TryRemove(sessionId, out _);
                    _ownershipRegistry.Remove(sessionId);
                }
            }

            OnStateChanged?.Invoke(sessionId);
            NotifyStateChange();
        }
        catch (Exception ex)
        {
            Log.Exception(ex, $"TtyHostSessionManager.HandleClientStateChanged({sessionId})");
        }
    }

    private static void MergeCachedFields(SessionInfo refreshed, SessionInfo existing)
    {
        // These fields are mt-owned metadata, not provided by mthost GetInfo.
        refreshed.TerminalTitle = existing.TerminalTitle;
        refreshed.ManuallyNamed = existing.ManuallyNamed;

        // Preserve user rename if a sparse refresh omits name.
        if (string.IsNullOrWhiteSpace(refreshed.Name) &&
            existing.ManuallyNamed &&
            !string.IsNullOrWhiteSpace(existing.Name))
        {
            refreshed.Name = existing.Name;
        }

        // Always prefer the existing CWD — it's kept current by HandleOscCwdUpdate
        // and HandleClientForegroundChanged. The refreshed snapshot from GetInfoAsync
        // reads the Win32 process PEB, which is stale on PowerShell (Set-Location
        // doesn't call SetCurrentDirectoryW). Only use the refreshed value for
        // initial population when the existing entry has no CWD yet.
        if (!string.IsNullOrWhiteSpace(existing.CurrentDirectory))
        {
            refreshed.CurrentDirectory = existing.CurrentDirectory;
        }

        if (refreshed.ForegroundPid is null && existing.ForegroundPid is not null)
        {
            refreshed.ForegroundPid = existing.ForegroundPid;
        }

        if (string.IsNullOrWhiteSpace(refreshed.ForegroundName) &&
            !string.IsNullOrWhiteSpace(existing.ForegroundName))
        {
            refreshed.ForegroundName = existing.ForegroundName;
        }

        if (string.IsNullOrWhiteSpace(refreshed.ForegroundCommandLine) &&
            !string.IsNullOrWhiteSpace(existing.ForegroundCommandLine))
        {
            refreshed.ForegroundCommandLine = existing.ForegroundCommandLine;
        }

        if (refreshed.AgentAttachPoint is null && existing.AgentAttachPoint is not null)
        {
            refreshed.AgentAttachPoint = existing.AgentAttachPoint;
        }
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
        foreach (var sessionId in _registry.TempDirectorySessionIds)
        {
            CleanupTempDirectory(sessionId);
        }

        _registry.ClearAll();
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

    public sealed class TerminalTransportRuntimeSnapshot
    {
        public ulong SourceSeq { get; init; }
        public ulong MuxReceivedSeq { get; init; }
        public int ReconnectCount { get; init; }
        public int DataLossCount { get; init; }
        public TerminalReplayReason? LastDataLossReason { get; init; }
        public int LastReplayBytes { get; init; }
        public TerminalReplayReason? LastReplayReason { get; init; }
    }

    private sealed class TerminalTransportRuntimeState
    {
        public ulong SourceSeq;
        public ulong MuxReceivedSeq;
        public int ReconnectCount;
        public int DataLossCount;
        public TerminalReplayReason? LastDataLossReason;
        public int LastReplayBytes;
        public TerminalReplayReason? LastReplayReason;

        public TerminalTransportRuntimeSnapshot ToSnapshot()
        {
            return new TerminalTransportRuntimeSnapshot
            {
                SourceSeq = SourceSeq,
                MuxReceivedSeq = MuxReceivedSeq,
                ReconnectCount = ReconnectCount,
                DataLossCount = DataLossCount,
                LastDataLossReason = LastDataLossReason,
                LastReplayBytes = LastReplayBytes,
                LastReplayReason = LastReplayReason
            };
        }
    }
}
