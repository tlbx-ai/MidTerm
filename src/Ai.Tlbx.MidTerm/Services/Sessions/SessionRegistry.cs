using System.Collections.Concurrent;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

internal sealed class SessionRegistry
{
    private readonly ConcurrentDictionary<string, Action> _stateListeners = new();
    private readonly ConcurrentDictionary<string, string> _tempDirectories = new();
    private readonly string _dropsBasePath;
    private readonly SessionControlStateService? _sessionControlStateService;
    private int _nextOrder;

    public SessionRegistry(bool isServiceMode, SessionControlStateService? sessionControlStateService = null)
    {
        _dropsBasePath = GetDropsBasePath(isServiceMode);
        _sessionControlStateService = sessionControlStateService;
    }

    public ConcurrentDictionary<string, TtyHostClient> Clients { get; } = new();

    public ConcurrentDictionary<string, SessionInfo> SessionCache { get; } = new();

    public ConcurrentDictionary<string, int> SessionOrder { get; } = new();

    public ConcurrentDictionary<string, byte> TmuxCreatedSessions { get; } = new();

    public ConcurrentDictionary<string, byte> TmuxCommandStarted { get; } = new();

    public ConcurrentDictionary<string, byte> HiddenSessions { get; } = new();

    public ConcurrentDictionary<string, string> TmuxParentSessions { get; } = new();

    public ConcurrentDictionary<string, string> BookmarkLinks { get; } = new();

    public ConcurrentDictionary<string, byte> AgentControlledSessions { get; } = new();

    public int ClientCount => Clients.Count;

    public int SessionCount => SessionCache.Count;

    public int NextOrder => Volatile.Read(ref _nextOrder);

    public void SetNextOrder(int nextOrder)
    {
        Interlocked.Exchange(ref _nextOrder, nextOrder);
    }

    public int ReserveNextOrder()
    {
        return Interlocked.Increment(ref _nextOrder);
    }

    public SessionInfo? GetSession(string sessionId)
    {
        return SessionCache.TryGetValue(sessionId, out var info) ? info : null;
    }

    public string GetTempDirectory(string sessionId)
    {
        return _tempDirectories.GetOrAdd(sessionId, id =>
        {
            var tempPath = Path.Combine(_dropsBasePath, id);
            Directory.CreateDirectory(tempPath);
            return tempPath;
        });
    }

    public void CleanupTempDirectory(string sessionId)
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
            }
        }
    }

    public void MarkHidden(string sessionId)
    {
        HiddenSessions.TryAdd(sessionId, 0);
    }

    public bool IsHidden(string sessionId)
    {
        return HiddenSessions.ContainsKey(sessionId);
    }

    public void MarkTmuxCreated(string sessionId)
    {
        TmuxCreatedSessions.TryAdd(sessionId, 0);
    }

    public void SetTmuxParent(string childSessionId, string parentSessionId)
    {
        while (TmuxParentSessions.TryGetValue(parentSessionId, out var grandparent))
        {
            parentSessionId = grandparent;
        }

        TmuxParentSessions[childSessionId] = parentSessionId;

        if (IsAgentControlled(parentSessionId))
        {
            AgentControlledSessions[childSessionId] = 0;
            _sessionControlStateService?.SetAgentControlled(childSessionId, agentControlled: true);
        }
    }

    public IReadOnlyList<SessionInfo> GetAllSessions()
    {
        return SessionCache.Values.ToList();
    }

    public SessionListDto GetSessionList()
    {
        return new SessionListDto
        {
            Sessions = SessionCache.Values
                .Where(s => !HiddenSessions.ContainsKey(s.Id))
                .Select(s => new SessionInfoDto
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
                    AgentAttachPoint = s.AgentAttachPoint,
                    Order = SessionOrder.TryGetValue(s.Id, out var order) ? order : int.MaxValue,
                    ParentSessionId = TmuxParentSessions.TryGetValue(s.Id, out var parentId) ? parentId : null,
                    BookmarkId = BookmarkLinks.TryGetValue(s.Id, out var bookmarkId) ? bookmarkId : null,
                    AgentControlled = IsAgentControlled(s.Id)
                })
                .OrderBy(s => s.Order)
                .ToList()
        };
    }

    public void RemoveSessionState(string sessionId)
    {
        SessionCache.TryRemove(sessionId, out _);
        SessionOrder.TryRemove(sessionId, out _);
        TmuxCreatedSessions.TryRemove(sessionId, out _);
        TmuxCommandStarted.TryRemove(sessionId, out _);
        HiddenSessions.TryRemove(sessionId, out _);
        TmuxParentSessions.TryRemove(sessionId, out _);
        BookmarkLinks.TryRemove(sessionId, out _);
        AgentControlledSessions.TryRemove(sessionId, out _);
        _sessionControlStateService?.RemoveSession(sessionId);

        foreach (var kvp in TmuxParentSessions.ToArray())
        {
            if (kvp.Value == sessionId)
            {
                TmuxParentSessions.TryRemove(kvp.Key, out _);
            }
        }

        CleanupTempDirectory(sessionId);
    }

    public bool SetBookmarkId(string sessionId, string bookmarkId)
    {
        if (!SessionCache.ContainsKey(sessionId))
        {
            return false;
        }

        BookmarkLinks[sessionId] = bookmarkId;
        NotifyStateChange();
        return true;
    }

    public bool SetAgentControlled(string sessionId, bool agentControlled)
    {
        if (!SessionCache.ContainsKey(sessionId))
        {
            return false;
        }

        foreach (var relatedSessionId in GetTmuxFamilySessionIds(sessionId))
        {
            if (agentControlled)
            {
                AgentControlledSessions[relatedSessionId] = 0;
            }
            else
            {
                AgentControlledSessions.TryRemove(relatedSessionId, out _);
            }

            _sessionControlStateService?.SetAgentControlled(relatedSessionId, agentControlled);
        }

        NotifyStateChange();
        return true;
    }

    public int ClearBookmarksByHistoryId(string bookmarkId)
    {
        if (string.IsNullOrWhiteSpace(bookmarkId))
        {
            return 0;
        }

        var removed = 0;
        foreach (var link in BookmarkLinks.ToArray())
        {
            if (!string.Equals(link.Value, bookmarkId, StringComparison.Ordinal))
            {
                continue;
            }

            if (BookmarkLinks.TryRemove(link.Key, out _))
            {
                removed++;
            }
        }

        if (removed > 0)
        {
            NotifyStateChange();
        }

        return removed;
    }

    public bool ReorderSessions(IList<string> sessionIds)
    {
        foreach (var id in sessionIds)
        {
            if (!SessionCache.ContainsKey(id))
            {
                return false;
            }
        }

        for (var i = 0; i < sessionIds.Count; i++)
        {
            SessionOrder[sessionIds[i]] = i;
        }

        NotifyStateChange();
        return true;
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

    public void NotifyStateChange()
    {
        foreach (var listener in _stateListeners.Values)
        {
            try
            {
                listener();
            }
            catch (Exception ex)
            {
                Log.Exception(ex, "TtyHostSessionManager.NotifyStateChange");
            }
        }
    }

    public IReadOnlyList<string> TempDirectorySessionIds => _tempDirectories.Keys.ToList();

    public void ClearAll()
    {
        Clients.Clear();
        SessionCache.Clear();
        SessionOrder.Clear();
        TmuxCreatedSessions.Clear();
        TmuxCommandStarted.Clear();
        HiddenSessions.Clear();
        TmuxParentSessions.Clear();
        BookmarkLinks.Clear();
        AgentControlledSessions.Clear();
        _stateListeners.Clear();
        _tempDirectories.Clear();
    }

    private bool IsAgentControlled(string sessionId)
    {
        return AgentControlledSessions.ContainsKey(sessionId)
            || _sessionControlStateService?.IsAgentControlled(sessionId) == true;
    }

    private IReadOnlyList<string> GetTmuxFamilySessionIds(string sessionId)
    {
        var rootSessionId = TmuxParentSessions.TryGetValue(sessionId, out var parentSessionId)
            ? parentSessionId
            : sessionId;

        var sessionIds = new HashSet<string>(StringComparer.Ordinal)
        {
            rootSessionId
        };

        foreach (var kvp in TmuxParentSessions)
        {
            if (string.Equals(kvp.Value, rootSessionId, StringComparison.Ordinal))
            {
                sessionIds.Add(kvp.Key);
            }
        }

        if (SessionCache.ContainsKey(sessionId))
        {
            sessionIds.Add(sessionId);
        }

        return sessionIds
            .Where(id => SessionCache.ContainsKey(id))
            .ToList();
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
}
