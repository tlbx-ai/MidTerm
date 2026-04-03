using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLayoutStateService
{
    private readonly string _statePath;
    private readonly Lock _lock = new();
    private SessionLayoutState _state = new();
    private string _serializedState = string.Empty;

    public SessionLayoutStateService(SettingsService settingsService)
        : this(settingsService.SettingsDirectory)
    {
    }

    public SessionLayoutStateService(string settingsDirectory)
    {
        _statePath = Path.Combine(settingsDirectory, "session-layout.json");
        Load();
    }

    public event Action? OnChanged;

    public SessionLayoutState GetSnapshot(IEnumerable<string>? validSessionIds = null)
    {
        LayoutNode? root;
        string? focusedSessionId;
        lock (_lock)
        {
            root = CloneNode(_state.Root);
            focusedSessionId = _state.FocusedSessionId;
        }

        return ApplyNormalizedState(root, focusedSessionId, validSessionIds);
    }

    public SessionLayoutState UpdateLayout(
        LayoutNode? root,
        string? focusedSessionId,
        IEnumerable<string>? validSessionIds = null)
    {
        return ApplyNormalizedState(root, focusedSessionId, validSessionIds);
    }

    public SessionLayoutState PruneToValidSessions(IEnumerable<string>? validSessionIds)
    {
        LayoutNode? root;
        string? focusedSessionId;
        lock (_lock)
        {
            root = CloneNode(_state.Root);
            focusedSessionId = _state.FocusedSessionId;
        }

        return ApplyNormalizedState(root, focusedSessionId, validSessionIds);
    }

    public SessionLayoutState RemoveSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            lock (_lock)
            {
                return CloneState(_state);
            }
        }

        var remainingSessionIds = new List<string>();
        LayoutNode? root;
        string? focusedSessionId;
        lock (_lock)
        {
            root = CloneNode(_state.Root);
            focusedSessionId = _state.FocusedSessionId;
            CollectSessionIds(_state.Root, remainingSessionIds);
        }

        return ApplyNormalizedState(
            root,
            focusedSessionId,
            remainingSessionIds.Where(id => !string.Equals(id, sessionId, StringComparison.Ordinal)));
    }

    private SessionLayoutState ApplyNormalizedState(
        LayoutNode? root,
        string? focusedSessionId,
        IEnumerable<string>? validSessionIds)
    {
        SessionLayoutState snapshot;
        var changed = false;

        lock (_lock)
        {
            var normalized = Normalize(root, focusedSessionId, validSessionIds);
            var serialized = Serialize(normalized);
            if (!string.Equals(serialized, _serializedState, StringComparison.Ordinal))
            {
                _state = normalized;
                _serializedState = serialized;
                PersistLocked(serialized);
                changed = true;
            }

            snapshot = CloneState(_state);
        }

        if (changed)
        {
            OnChanged?.Invoke();
        }

        return snapshot;
    }

    private void Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_statePath))
            {
                _state = new SessionLayoutState();
                _serializedState = Serialize(_state);
                return;
            }

            try
            {
                var json = File.ReadAllText(_statePath);
                var state = JsonSerializer.Deserialize(
                                json,
                                SessionLayoutStateJsonContext.Default.SessionLayoutState)
                            ?? new SessionLayoutState();
                _state = Normalize(state.Root, state.FocusedSessionId, validSessionIds: null);
                _serializedState = Serialize(_state);
            }
            catch (Exception ex)
            {
                Log.Warn(() => $"Failed to load session layout state: {ex.Message}");
                _state = new SessionLayoutState();
                _serializedState = Serialize(_state);
            }
        }
    }

    private void PersistLocked(string serialized)
    {
        try
        {
            var dir = Path.GetDirectoryName(_statePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            if (_state.Root is null && string.IsNullOrWhiteSpace(_state.FocusedSessionId))
            {
                if (File.Exists(_statePath))
                {
                    File.Delete(_statePath);
                }

                return;
            }

            File.WriteAllText(_statePath, serialized);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Failed to save session layout state: {ex.Message}");
        }
    }

    private static SessionLayoutState Normalize(
        LayoutNode? root,
        string? focusedSessionId,
        IEnumerable<string>? validSessionIds)
    {
        HashSet<string>? validSet = null;
        if (validSessionIds is not null)
        {
            validSet = new HashSet<string>(
                validSessionIds.Where(id => !string.IsNullOrWhiteSpace(id)),
                StringComparer.Ordinal);
        }

        var normalizedRoot = CollapseSingleChildSplits(FilterAndClone(root, validSet));
        if (normalizedRoot is not null && !string.Equals(normalizedRoot.Type, "split", StringComparison.Ordinal))
        {
            normalizedRoot = null;
        }

        var sessionIds = new List<string>();
        CollectSessionIds(normalizedRoot, sessionIds);

        string? normalizedFocusedSessionId = null;
        if (sessionIds.Count > 0)
        {
            normalizedFocusedSessionId = !string.IsNullOrWhiteSpace(focusedSessionId)
                                         && sessionIds.Contains(focusedSessionId, StringComparer.Ordinal)
                ? focusedSessionId
                : sessionIds[0];
        }

        return new SessionLayoutState
        {
            Root = normalizedRoot,
            FocusedSessionId = normalizedFocusedSessionId
        };
    }

    private static LayoutNode? FilterAndClone(LayoutNode? node, HashSet<string>? validSessionIds)
    {
        if (node is null)
        {
            return null;
        }

        if (string.Equals(node.Type, "leaf", StringComparison.Ordinal))
        {
            if (string.IsNullOrWhiteSpace(node.SessionId))
            {
                return null;
            }

            if (validSessionIds is not null && !validSessionIds.Contains(node.SessionId))
            {
                return null;
            }

            return new LayoutNode
            {
                Type = "leaf",
                SessionId = node.SessionId
            };
        }

        if (!string.Equals(node.Type, "split", StringComparison.Ordinal) || node.Children is null)
        {
            return null;
        }

        var children = new List<LayoutNode>();
        foreach (var child in node.Children)
        {
            var filtered = FilterAndClone(child, validSessionIds);
            if (filtered is not null)
            {
                children.Add(filtered);
            }
        }

        if (children.Count == 0)
        {
            return null;
        }

        return new LayoutNode
        {
            Type = "split",
            Direction = node.Direction,
            Children = children
        };
    }

    private static LayoutNode? CollapseSingleChildSplits(LayoutNode? node)
    {
        if (node is null)
        {
            return null;
        }

        if (string.Equals(node.Type, "leaf", StringComparison.Ordinal))
        {
            return node;
        }

        if (!string.Equals(node.Type, "split", StringComparison.Ordinal) || node.Children is null)
        {
            return null;
        }

        var children = new List<LayoutNode>();
        foreach (var child in node.Children)
        {
            var collapsed = CollapseSingleChildSplits(child);
            if (collapsed is not null)
            {
                children.Add(collapsed);
            }
        }

        if (children.Count == 0)
        {
            return null;
        }

        if (children.Count == 1)
        {
            return children[0];
        }

        node.Children = children;
        return node;
    }

    private static void CollectSessionIds(LayoutNode? node, List<string> ids)
    {
        if (node is null)
        {
            return;
        }

        if (string.Equals(node.Type, "leaf", StringComparison.Ordinal))
        {
            if (!string.IsNullOrWhiteSpace(node.SessionId))
            {
                ids.Add(node.SessionId);
            }

            return;
        }

        if (node.Children is null)
        {
            return;
        }

        foreach (var child in node.Children)
        {
            CollectSessionIds(child, ids);
        }
    }

    private static SessionLayoutState CloneState(SessionLayoutState state)
    {
        return new SessionLayoutState
        {
            Root = CloneNode(state.Root),
            FocusedSessionId = state.FocusedSessionId
        };
    }

    private static LayoutNode? CloneNode(LayoutNode? node)
    {
        if (node is null)
        {
            return null;
        }

        return new LayoutNode
        {
            Type = node.Type,
            SessionId = node.SessionId,
            Direction = node.Direction,
            Children = node.Children?.Select(CloneNode).Where(child => child is not null).Cast<LayoutNode>().ToList()
        };
    }

    private static string Serialize(SessionLayoutState state)
    {
        return JsonSerializer.Serialize(state, SessionLayoutStateJsonContext.Default.SessionLayoutState);
    }
}
