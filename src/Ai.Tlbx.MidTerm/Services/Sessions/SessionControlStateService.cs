using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionControlStateService
{
    private readonly string _statePath;
    private readonly Lock _lock = new();
    private HashSet<string> _agentControlledSessionIds = new(StringComparer.Ordinal);
    private HashSet<string> _appServerControlOnlySessionIds = new(StringComparer.Ordinal);
    private Dictionary<string, string> _launchOrigins = new(StringComparer.Ordinal);
    private Dictionary<string, string> _profileHints = new(StringComparer.Ordinal);
    private Dictionary<string, string> _appServerControlResumeThreadIds = new(StringComparer.Ordinal);
    private Dictionary<string, string> _spaceIds = new(StringComparer.Ordinal);
    private Dictionary<string, string> _workspacePaths = new(StringComparer.Ordinal);
    private Dictionary<string, string> _surfaces = new(StringComparer.Ordinal);

    public SessionControlStateService(SettingsService settingsService)
        : this(settingsService.SettingsDirectory)
    {
    }

    public SessionControlStateService(string settingsDirectory)
    {
        _statePath = Path.Combine(settingsDirectory, "session-control.json");
        Load();
    }

    public bool IsAgentControlled(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        lock (_lock)
        {
            return _agentControlledSessionIds.Contains(sessionId);
        }
    }

    public bool IsAppServerControlOnly(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        lock (_lock)
        {
            return _appServerControlOnlySessionIds.Contains(sessionId);
        }
    }

    public string? GetProfileHint(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _profileHints.TryGetValue(sessionId, out var profileHint) ? profileHint : null;
        }
    }

    public string? GetLaunchOrigin(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _launchOrigins.TryGetValue(sessionId, out var launchOrigin) ? launchOrigin : null;
        }
    }

    public string? GetAppServerControlResumeThreadId(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _appServerControlResumeThreadIds.TryGetValue(sessionId, out var resumeThreadId) ? resumeThreadId : null;
        }
    }

    public string? GetSpaceId(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _spaceIds.TryGetValue(sessionId, out var spaceId) ? spaceId : null;
        }
    }

    public string? GetWorkspacePath(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _workspacePaths.TryGetValue(sessionId, out var workspacePath) ? workspacePath : null;
        }
    }

    public string? GetSurface(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _surfaces.TryGetValue(sessionId, out var surface) ? surface : null;
        }
    }

    public void SetAgentControlled(string sessionId, bool agentControlled)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var changed = agentControlled
                ? _agentControlledSessionIds.Add(sessionId)
                : _agentControlledSessionIds.Remove(sessionId);

            if (!changed)
            {
                return;
            }

            PersistLocked();
        }
    }

    public void SetAppServerControlOnly(string sessionId, bool appServerControlOnly)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var changed = appServerControlOnly
                ? _appServerControlOnlySessionIds.Add(sessionId)
                : _appServerControlOnlySessionIds.Remove(sessionId);

            if (!changed)
            {
                return;
            }

            PersistLocked();
        }
    }

    public void SetProfileHint(string sessionId, string? profile)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var normalized = profile?.Trim();
            var changed = false;
            if (string.IsNullOrWhiteSpace(normalized))
            {
                changed = _profileHints.Remove(sessionId);
            }
            else if (!_profileHints.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.Ordinal))
            {
                _profileHints[sessionId] = normalized;
                changed = true;
            }

            if (!changed)
            {
                return;
            }

            PersistLocked();
        }
    }

    public void SetLaunchOrigin(string sessionId, string? launchOrigin)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var normalized = SessionLaunchOrigins.Normalize(launchOrigin);
            var changed = false;
            if (string.IsNullOrWhiteSpace(normalized))
            {
                changed = _launchOrigins.Remove(sessionId);
            }
            else if (!_launchOrigins.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.Ordinal))
            {
                _launchOrigins[sessionId] = normalized;
                changed = true;
            }

            if (!changed)
            {
                return;
            }

            PersistLocked();
        }
    }

    public void SetAppServerControlResumeThreadId(string sessionId, string? resumeThreadId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var normalized = resumeThreadId?.Trim();
            var changed = false;
            if (string.IsNullOrWhiteSpace(normalized))
            {
                changed = _appServerControlResumeThreadIds.Remove(sessionId);
            }
            else if (!_appServerControlResumeThreadIds.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.Ordinal))
            {
                _appServerControlResumeThreadIds[sessionId] = normalized;
                changed = true;
            }

            if (!changed)
            {
                return;
            }

            PersistLocked();
        }
    }

    public void SetSpaceId(string sessionId, string? spaceId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var normalized = spaceId?.Trim();
            var changed = false;
            if (string.IsNullOrWhiteSpace(normalized))
            {
                changed = _spaceIds.Remove(sessionId);
            }
            else if (!_spaceIds.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.Ordinal))
            {
                _spaceIds[sessionId] = normalized;
                changed = true;
            }

            if (changed)
            {
                PersistLocked();
            }
        }
    }

    public void SetWorkspacePath(string sessionId, string? workspacePath)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var normalized = workspacePath?.Trim();
            var changed = false;
            if (string.IsNullOrWhiteSpace(normalized))
            {
                changed = _workspacePaths.Remove(sessionId);
            }
            else if (!_workspacePaths.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.OrdinalIgnoreCase))
            {
                _workspacePaths[sessionId] = normalized;
                changed = true;
            }

            if (changed)
            {
                PersistLocked();
            }
        }
    }

    public void SetSurface(string sessionId, string? surface)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var normalized = surface?.Trim();
            var changed = false;
            if (string.IsNullOrWhiteSpace(normalized))
            {
                changed = _surfaces.Remove(sessionId);
            }
            else if (!_surfaces.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.OrdinalIgnoreCase))
            {
                _surfaces[sessionId] = normalized;
                changed = true;
            }

            if (changed)
            {
                PersistLocked();
            }
        }
    }

    public void RemoveSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var changed = _agentControlledSessionIds.Remove(sessionId);
            changed |= _appServerControlOnlySessionIds.Remove(sessionId);
            changed |= _launchOrigins.Remove(sessionId);
            changed |= _profileHints.Remove(sessionId);
            changed |= _appServerControlResumeThreadIds.Remove(sessionId);
            changed |= _spaceIds.Remove(sessionId);
            changed |= _workspacePaths.Remove(sessionId);
            changed |= _surfaces.Remove(sessionId);
            if (!changed)
            {
                return;
            }

            PersistLocked();
        }
    }

    private void Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_statePath))
            {
                _agentControlledSessionIds = new HashSet<string>(StringComparer.Ordinal);
                return;
            }

            try
            {
                var json = File.ReadAllText(_statePath);
                var state = JsonSerializer.Deserialize(json, SessionControlStateJsonContext.Default.SessionControlState)
                    ?? new SessionControlState();
                _agentControlledSessionIds = new HashSet<string>(
                    state.AgentControlledSessionIds.Where(id => !string.IsNullOrWhiteSpace(id)),
                    StringComparer.Ordinal);
                _appServerControlOnlySessionIds = new HashSet<string>(
                    state.AppServerControlOnlySessionIds.Where(id => !string.IsNullOrWhiteSpace(id)),
                    StringComparer.Ordinal);
                _launchOrigins = state.LaunchOrigins
                    .Select(kvp => new KeyValuePair<string, string?>(kvp.Key, SessionLaunchOrigins.Normalize(kvp.Value)))
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value!, StringComparer.Ordinal);
                _profileHints = state.ProfileHints
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
                _appServerControlResumeThreadIds = state.AppServerControlResumeThreadIds
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
                _spaceIds = state.SpaceIds
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
                _workspacePaths = state.WorkspacePaths
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
                _surfaces = state.Surfaces
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to load session control state: {ex.Message}");
                _agentControlledSessionIds = new HashSet<string>(StringComparer.Ordinal);
                _appServerControlOnlySessionIds = new HashSet<string>(StringComparer.Ordinal);
                _launchOrigins = new Dictionary<string, string>(StringComparer.Ordinal);
                _profileHints = new Dictionary<string, string>(StringComparer.Ordinal);
                _appServerControlResumeThreadIds = new Dictionary<string, string>(StringComparer.Ordinal);
                _spaceIds = new Dictionary<string, string>(StringComparer.Ordinal);
                _workspacePaths = new Dictionary<string, string>(StringComparer.Ordinal);
                _surfaces = new Dictionary<string, string>(StringComparer.Ordinal);
            }
        }
    }

    private void PersistLocked()
    {
        try
        {
            var dir = Path.GetDirectoryName(_statePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            var snapshot = new SessionControlState
            {
                AgentControlledSessionIds = _agentControlledSessionIds
                    .OrderBy(id => id, StringComparer.Ordinal)
                    .ToList(),
                AppServerControlOnlySessionIds = _appServerControlOnlySessionIds
                    .OrderBy(id => id, StringComparer.Ordinal)
                    .ToList(),
                LaunchOrigins = _launchOrigins
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal),
                ProfileHints = _profileHints
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal),
                AppServerControlResumeThreadIds = _appServerControlResumeThreadIds
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal),
                SpaceIds = _spaceIds
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal),
                WorkspacePaths = _workspacePaths
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal),
                Surfaces = _surfaces
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal)
            };

            var json = JsonSerializer.Serialize(snapshot, SessionControlStateJsonContext.Default.SessionControlState);
            File.WriteAllText(_statePath, json);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Failed to save session control state: {ex.Message}");
        }
    }
}
