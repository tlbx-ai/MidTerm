using System.Collections.Concurrent;
using Ai.Tlbx.MiddleManager.Ipc;
using Ai.Tlbx.MiddleManager.Models;
using Ai.Tlbx.MiddleManager.Settings;
using Ai.Tlbx.MiddleManager.Shells;

namespace Ai.Tlbx.MiddleManager.Services;

/// <summary>
/// SessionManager that proxies all operations to the mm-host sidecar process.
/// Terminal sessions are owned by mm-host and survive web server restarts.
/// </summary>
public sealed class SidecarSessionManager : IDisposable
{
    private readonly ConcurrentDictionary<string, SessionSnapshot> _sessions = new();
    private readonly ConcurrentDictionary<string, Action> _stateListeners = new();
    private readonly ShellRegistry _shellRegistry;
    private readonly SettingsService _settingsService;
    private readonly SidecarClient _sidecarClient;
    private SidecarMuxConnectionManager? _muxManager;
    private bool _disposed;

    public ShellRegistry ShellRegistry => _shellRegistry;
    public SettingsService SettingsService => _settingsService;
    public SidecarClient SidecarClient => _sidecarClient;
    public bool IsConnected => _sidecarClient.IsConnected;
    public bool IsHealthy => _sidecarClient.IsHealthy;

    public SidecarSessionManager(
        ShellRegistry shellRegistry,
        SettingsService settingsService,
        SidecarClient sidecarClient)
    {
        _shellRegistry = shellRegistry;
        _settingsService = settingsService;
        _sidecarClient = sidecarClient;

        _sidecarClient.OnOutput += HandleSidecarOutput;
        _sidecarClient.OnStateChanged += HandleSidecarStateChange;
        _sidecarClient.OnDisconnected += HandleSidecarDisconnected;
        _sidecarClient.OnReconnected += HandleSidecarReconnected;
    }

    public void SetMuxManager(SidecarMuxConnectionManager muxManager)
    {
        _muxManager = muxManager;
    }

    public async Task SyncSessionsAsync(CancellationToken cancellationToken = default)
    {
        if (!_sidecarClient.IsConnected)
        {
            return;
        }

        var snapshots = await _sidecarClient.ListSessionsAsync(cancellationToken).ConfigureAwait(false);
        _sessions.Clear();
        foreach (var snapshot in snapshots)
        {
            _sessions[snapshot.Id] = snapshot;
        }
        NotifyStateChange();
    }

    public async Task<SessionSnapshot?> CreateSessionAsync(
        int cols = 120,
        int rows = 30,
        ShellType? shellType = null,
        CancellationToken cancellationToken = default)
    {
        if (!_sidecarClient.IsConnected)
        {
            return null;
        }

        var settings = _settingsService.Load();
        var effectiveShellType = shellType ?? settings.DefaultShell;

        var request = new IpcCreateSessionRequest
        {
            ShellType = effectiveShellType.ToString(),
            WorkingDirectory = GetDefaultWorkingDirectory(settings),
            Cols = cols,
            Rows = rows,
            RunAsUser = settings.RunAsUser,
            RunAsUserSid = settings.RunAsUserSid,
            RunAsUid = settings.RunAsUid,
            RunAsGid = settings.RunAsGid,
        };

        var snapshot = await _sidecarClient.CreateSessionAsync(request, cancellationToken).ConfigureAwait(false);
        if (snapshot is not null)
        {
            _sessions[snapshot.Id] = snapshot;
            NotifyStateChange();
        }

        return snapshot;
    }

    public SessionSnapshot? GetSession(string id)
    {
        return _sessions.TryGetValue(id, out var snapshot) ? snapshot : null;
    }

    public async Task CloseSessionAsync(string id, CancellationToken cancellationToken = default)
    {
        if (_sessions.TryRemove(id, out _))
        {
            await _sidecarClient.CloseSessionAsync(id, cancellationToken).ConfigureAwait(false);
            NotifyStateChange();
        }
    }

    public async Task SendInputAsync(string sessionId, ReadOnlyMemory<byte> data, CancellationToken cancellationToken = default)
    {
        await _sidecarClient.SendInputAsync(sessionId, data, cancellationToken).ConfigureAwait(false);
    }

    public async Task ResizeAsync(string sessionId, int cols, int rows, CancellationToken cancellationToken = default)
    {
        await _sidecarClient.ResizeAsync(sessionId, cols, rows, cancellationToken).ConfigureAwait(false);

        if (_sessions.TryGetValue(sessionId, out var snapshot))
        {
            snapshot.Cols = cols;
            snapshot.Rows = rows;
        }
    }

    public async Task<byte[]?> GetBufferAsync(string sessionId, CancellationToken cancellationToken = default)
    {
        return await _sidecarClient.GetBufferAsync(sessionId, cancellationToken).ConfigureAwait(false);
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
            try
            {
                listener();
            }
            catch
            {
            }
        }
    }

    public SessionListDto GetSessionList()
    {
        return new SessionListDto
        {
            Sessions = _sessions.Values.Select(s => new SessionInfoDto
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
                LastActiveViewerId = null
            }).OrderBy(s => s.CreatedAt).ToList()
        };
    }

    private void HandleSidecarOutput(string sessionId, ReadOnlyMemory<byte> data)
    {
        if (_muxManager is not null)
        {
            _ = _muxManager.BroadcastTerminalOutputAsync(sessionId, data);
        }
    }

    private void HandleSidecarStateChange(SessionSnapshot snapshot)
    {
        _sessions[snapshot.Id] = snapshot;
        NotifyStateChange();
    }

    private void HandleSidecarDisconnected()
    {
        Console.WriteLine("Sidecar disconnected");
        NotifyStateChange();
    }

    private void HandleSidecarReconnected()
    {
        Console.WriteLine("Sidecar reconnected, syncing sessions...");
        _ = SyncSessionsAsync();
    }

    private static string GetDefaultWorkingDirectory(Settings.MiddleManagerSettings settings)
    {
        if (!string.IsNullOrWhiteSpace(settings.DefaultWorkingDirectory) &&
            Directory.Exists(settings.DefaultWorkingDirectory))
        {
            return settings.DefaultWorkingDirectory;
        }

        try
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }
        catch
        {
            return Environment.CurrentDirectory;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;

        _sidecarClient.OnOutput -= HandleSidecarOutput;
        _sidecarClient.OnStateChanged -= HandleSidecarStateChange;
        _sidecarClient.OnDisconnected -= HandleSidecarDisconnected;
        _sidecarClient.OnReconnected -= HandleSidecarReconnected;

        _sessions.Clear();
        _stateListeners.Clear();
    }
}
