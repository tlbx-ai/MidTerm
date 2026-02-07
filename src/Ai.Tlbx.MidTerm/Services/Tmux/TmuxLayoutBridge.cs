using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Services.Tmux;

/// <summary>
/// Bridge between tmux commands and the frontend layout system.
/// Stores layout tree snapshots from the frontend and broadcasts
/// dock/focus instructions via a callback.
/// </summary>
public sealed class TmuxLayoutBridge
{
    private LayoutNode? _layoutRoot;
    private readonly object _layoutLock = new();

    /// <summary>
    /// Fired when the tmux layer wants the frontend to dock a session.
    /// Parameters: newSessionId, relativeToSessionId, position ("left"|"right"|"top"|"bottom")
    /// </summary>
    public event Action<string, string, string>? OnDockRequested;

    /// <summary>
    /// Fired when the tmux layer wants the frontend to focus a session.
    /// </summary>
    public event Action<string>? OnFocusRequested;

    /// <summary>
    /// Ask the frontend to dock a new pane adjacent to an existing one.
    /// </summary>
    public void RequestDock(string newSessionId, string relativeToSessionId, string position)
    {
        OnDockRequested?.Invoke(newSessionId, relativeToSessionId, position);
    }

    /// <summary>
    /// Ask the frontend to focus/activate a session.
    /// </summary>
    public void RequestFocus(string sessionId)
    {
        OnFocusRequested?.Invoke(sessionId);
    }

    /// <summary>
    /// Update the cached layout tree (called when frontend sends layout state).
    /// </summary>
    public void UpdateLayout(LayoutNode? root)
    {
        lock (_layoutLock)
        {
            _layoutRoot = root;
        }
    }

    /// <summary>
    /// Find the session adjacent to the given session in the specified direction.
    /// Uses the layout tree structure to resolve 2D adjacency.
    /// </summary>
    public string? GetAdjacentSession(string sessionId, string direction)
    {
        LayoutNode? root;
        lock (_layoutLock)
        {
            root = _layoutRoot;
        }

        if (root is null)
        {
            return null;
        }

        var path = FindPathToSession(root, sessionId);
        if (path is null)
        {
            return null;
        }

        var axis = direction is "left" or "right" ? "horizontal" : "vertical";
        var forward = direction is "right" or "down";

        for (var depth = path.Count - 2; depth >= 0; depth--)
        {
            var (node, childIndex) = path[depth];
            if (node.Direction == axis && node.Children is not null)
            {
                var targetIndex = forward ? childIndex + 1 : childIndex - 1;
                if (targetIndex >= 0 && targetIndex < node.Children.Count)
                {
                    var adjacent = node.Children[targetIndex];
                    return forward ? GetFirstLeaf(adjacent) : GetLastLeaf(adjacent);
                }
            }
        }

        return null;
    }

    private static List<(LayoutNode node, int childIndex)>? FindPathToSession(LayoutNode root, string sessionId)
    {
        var path = new List<(LayoutNode, int)>();
        if (FindPathRecursive(root, sessionId, path))
        {
            return path;
        }
        return null;
    }

    private static bool FindPathRecursive(LayoutNode node, string sessionId, List<(LayoutNode, int)> path)
    {
        if (node.Type == "leaf")
        {
            return node.SessionId == sessionId;
        }

        if (node.Children is null)
        {
            return false;
        }

        for (var i = 0; i < node.Children.Count; i++)
        {
            path.Add((node, i));
            if (FindPathRecursive(node.Children[i], sessionId, path))
            {
                return true;
            }
            path.RemoveAt(path.Count - 1);
        }

        return false;
    }

    private static string? GetFirstLeaf(LayoutNode node)
    {
        while (true)
        {
            if (node.Type == "leaf")
            {
                return node.SessionId;
            }
            if (node.Children is null || node.Children.Count == 0)
            {
                return null;
            }
            node = node.Children[0];
        }
    }

    private static string? GetLastLeaf(LayoutNode node)
    {
        while (true)
        {
            if (node.Type == "leaf")
            {
                return node.SessionId;
            }
            if (node.Children is null || node.Children.Count == 0)
            {
                return null;
            }
            node = node.Children[^1];
        }
    }
}

/// <summary>
/// Layout tree node received from the frontend. "leaf" nodes hold a session,
/// "split" nodes hold children with a direction ("horizontal" or "vertical").
/// </summary>
public sealed class LayoutNode
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("sessionId")]
    public string? SessionId { get; set; }

    [JsonPropertyName("direction")]
    public string? Direction { get; set; }

    [JsonPropertyName("children")]
    public List<LayoutNode>? Children { get; set; }
}
