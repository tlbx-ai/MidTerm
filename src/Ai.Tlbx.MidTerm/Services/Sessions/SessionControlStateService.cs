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
    private HashSet<string> _lensOnlySessionIds = new(StringComparer.Ordinal);
    private Dictionary<string, string> _profileHints = new(StringComparer.Ordinal);
    private Dictionary<string, string> _lensResumeThreadIds = new(StringComparer.Ordinal);

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

    public bool IsLensOnly(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return false;
        }

        lock (_lock)
        {
            return _lensOnlySessionIds.Contains(sessionId);
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

    public string? GetLensResumeThreadId(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        lock (_lock)
        {
            return _lensResumeThreadIds.TryGetValue(sessionId, out var resumeThreadId) ? resumeThreadId : null;
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

    public void SetLensOnly(string sessionId, bool lensOnly)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            var changed = lensOnly
                ? _lensOnlySessionIds.Add(sessionId)
                : _lensOnlySessionIds.Remove(sessionId);

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

    public void SetLensResumeThreadId(string sessionId, string? resumeThreadId)
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
                changed = _lensResumeThreadIds.Remove(sessionId);
            }
            else if (!_lensResumeThreadIds.TryGetValue(sessionId, out var existing) ||
                     !string.Equals(existing, normalized, StringComparison.Ordinal))
            {
                _lensResumeThreadIds[sessionId] = normalized;
                changed = true;
            }

            if (!changed)
            {
                return;
            }

            PersistLocked();
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
            changed |= _lensOnlySessionIds.Remove(sessionId);
            changed |= _profileHints.Remove(sessionId);
            changed |= _lensResumeThreadIds.Remove(sessionId);
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
                _lensOnlySessionIds = new HashSet<string>(
                    state.LensOnlySessionIds.Where(id => !string.IsNullOrWhiteSpace(id)),
                    StringComparer.Ordinal);
                _profileHints = state.ProfileHints
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
                _lensResumeThreadIds = state.LensResumeThreadIds
                    .Where(kvp => !string.IsNullOrWhiteSpace(kvp.Key) && !string.IsNullOrWhiteSpace(kvp.Value))
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal);
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to load session control state: {ex.Message}");
                _agentControlledSessionIds = new HashSet<string>(StringComparer.Ordinal);
                _lensOnlySessionIds = new HashSet<string>(StringComparer.Ordinal);
                _profileHints = new Dictionary<string, string>(StringComparer.Ordinal);
                _lensResumeThreadIds = new Dictionary<string, string>(StringComparer.Ordinal);
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
                LensOnlySessionIds = _lensOnlySessionIds
                    .OrderBy(id => id, StringComparer.Ordinal)
                    .ToList(),
                ProfileHints = _profileHints
                    .OrderBy(kvp => kvp.Key, StringComparer.Ordinal)
                    .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, StringComparer.Ordinal),
                LensResumeThreadIds = _lensResumeThreadIds
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
