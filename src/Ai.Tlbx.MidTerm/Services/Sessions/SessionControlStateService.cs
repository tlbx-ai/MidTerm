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

    public void RemoveSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        lock (_lock)
        {
            if (!_agentControlledSessionIds.Remove(sessionId))
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
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to load session control state: {ex.Message}");
                _agentControlledSessionIds = new HashSet<string>(StringComparer.Ordinal);
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
                    .ToList()
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
