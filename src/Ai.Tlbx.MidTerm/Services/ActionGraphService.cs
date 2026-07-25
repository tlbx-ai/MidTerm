using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.ActionGraphs;
using Ai.Tlbx.MidTerm.Settings;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// Durable store for agent-curated action graphs. Pure verbatim CRUD: tlbx persists
/// nodes, edges, positions, and launch specs — it never derives meaning from them.
/// </summary>
public sealed class ActionGraphService : IDisposable
{
    internal const int MaxGraphs = 50;
    internal const int MaxNodesPerGraph = 500;
    internal const int MaxEdgesPerGraph = 1000;
    internal const int MaxActionsPerNode = 8;
    private const int MaxTitleLength = 256;
    private const int MaxStateLength = 256;
    private const int MaxHtmlLength = 65536;
    private const int MaxPromptLength = 8192;
    private const int MaxLabelLength = 128;
    private const int MaxReferenceLength = 4096;
    private static readonly TimeSpan SaveDebounceDelay = TimeSpan.FromMilliseconds(200);

    private readonly string _path;
    private readonly Lock _lock = new();
    private readonly Timer _saveTimer;
    private ActionGraphsDocument _document = new();
    private bool _savePending;
    private bool _disposed;

    public ActionGraphService(SettingsService settingsService)
    {
        _path = Path.Combine(settingsService.SettingsDirectory, "action-graphs.json");
        _saveTimer = new Timer(_ => FlushPendingSave(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        Load();
    }

    public ActionGraphListResponse ListGraphs()
    {
        lock (_lock)
        {
            return new ActionGraphListResponse
            {
                Graphs = _document.Graphs
                    .OrderBy(static graph => graph.Name, StringComparer.OrdinalIgnoreCase)
                    .Select(static graph => new ActionGraphSummary
                    {
                        Id = graph.Id,
                        Name = graph.Name,
                        NodeCount = graph.Nodes.Count,
                        EdgeCount = graph.Edges.Count,
                        UpdatedAt = graph.UpdatedAt
                    })
                    .ToList()
            };
        }
    }

    public ActionGraph CreateGraph(CreateActionGraphRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ObjectDisposedException.ThrowIf(_disposed, this);

        lock (_lock)
        {
            var graph = GetOrCreateGraphLocked(request.Id, request.Name);
            return Clone(graph);
        }
    }

    public bool DeleteGraph(string graphId)
    {
        var id = ValidId(graphId, nameof(graphId));
        lock (_lock)
        {
            var removed = _document.Graphs.RemoveAll(graph => string.Equals(graph.Id, id, StringComparison.Ordinal)) > 0;
            if (removed)
            {
                ScheduleSaveLocked();
            }
            return removed;
        }
    }

    public ActionGraph? GetGraph(string graphId)
    {
        var id = ValidId(graphId, nameof(graphId));
        lock (_lock)
        {
            var graph = FindGraphLocked(id);
            return graph is null ? null : Clone(graph);
        }
    }

    public ActionGraphNode CreateNode(string graphId, UpsertActionGraphNodeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ObjectDisposedException.ThrowIf(_disposed, this);
        var id = ValidId(graphId, nameof(graphId));

        lock (_lock)
        {
            var graph = GetOrCreateGraphLocked(id, name: null);
            if (graph.Nodes.Count >= MaxNodesPerGraph)
            {
                throw new ArgumentException($"Graph '{graph.Id}' already holds the maximum of {MaxNodesPerGraph} nodes.");
            }

            var nodeId = request.Id is null ? NewId() : ValidId(request.Id, nameof(request.Id));
            if (graph.Nodes.Any(node => string.Equals(node.Id, nodeId, StringComparison.Ordinal)))
            {
                throw new ArgumentException($"Node '{nodeId}' already exists in graph '{graph.Id}'.");
            }

            var now = DateTimeOffset.UtcNow;
            var node = new ActionGraphNode
            {
                Id = nodeId,
                Kind = Optional(request.Kind, 64) ?? ActionGraphNodeKinds.Identity,
                Title = Required(request.Title, MaxTitleLength, nameof(request.Title)),
                State = Optional(request.State, MaxStateLength),
                Html = Optional(request.Html, MaxHtmlLength),
                X = request.X ?? 0,
                Y = request.Y ?? 0,
                Width = request.Width,
                Color = Optional(request.Color, 32),
                Url = Optional(request.Url, MaxReferenceLength),
                Path = Optional(request.Path, MaxReferenceLength),
                Host = Optional(request.Host, MaxReferenceLength),
                Project = Optional(request.Project, MaxTitleLength),
                SessionId = Optional(request.SessionId, 128),
                ExternalRef = Optional(request.ExternalRef, MaxReferenceLength),
                Date = request.Date,
                Actions = NormalizedActions(request.Actions),
                Source = Optional(request.Source, 128) ?? "agent",
                CreatedAt = now,
                UpdatedAt = now,
                Revision = 1
            };
            graph.Nodes.Add(node);
            graph.UpdatedAt = now;
            ScheduleSaveLocked();
            return Clone(node);
        }
    }

    public ActionGraphNode? UpdateNode(string graphId, string nodeId, UpsertActionGraphNodeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ObjectDisposedException.ThrowIf(_disposed, this);
        var id = ValidId(graphId, nameof(graphId));
        var normalizedNodeId = ValidId(nodeId, nameof(nodeId));

        lock (_lock)
        {
            var graph = FindGraphLocked(id);
            var node = graph?.Nodes.FirstOrDefault(candidate =>
                string.Equals(candidate.Id, normalizedNodeId, StringComparison.Ordinal));
            if (graph is null || node is null)
            {
                return null;
            }

            if (request.Kind is not null) node.Kind = Optional(request.Kind, 64) ?? node.Kind;
            if (request.Title is not null) node.Title = Required(request.Title, MaxTitleLength, nameof(request.Title));
            if (request.State is not null) node.State = Optional(request.State, MaxStateLength);
            if (request.Html is not null) node.Html = Optional(request.Html, MaxHtmlLength);
            // Position ownership: publishes keep manual layout unless they explicitly move a node.
            if (request.X is not null) node.X = request.X.Value;
            if (request.Y is not null) node.Y = request.Y.Value;
            if (request.Width is not null) node.Width = request.Width;
            if (request.Color is not null) node.Color = Optional(request.Color, 32);
            if (request.Url is not null) node.Url = Optional(request.Url, MaxReferenceLength);
            if (request.Path is not null) node.Path = Optional(request.Path, MaxReferenceLength);
            if (request.Host is not null) node.Host = Optional(request.Host, MaxReferenceLength);
            if (request.Project is not null) node.Project = Optional(request.Project, MaxTitleLength);
            if (request.SessionId is not null) node.SessionId = Optional(request.SessionId, 128);
            if (request.ExternalRef is not null) node.ExternalRef = Optional(request.ExternalRef, MaxReferenceLength);
            if (request.Date is not null) node.Date = request.Date;
            if (request.Actions is not null) node.Actions = NormalizedActions(request.Actions);
            if (request.Source is not null) node.Source = Optional(request.Source, 128) ?? node.Source;
            node.UpdatedAt = DateTimeOffset.UtcNow;
            node.Revision++;
            graph.UpdatedAt = node.UpdatedAt;
            ScheduleSaveLocked();
            return Clone(node);
        }
    }

    public bool SetNodePosition(string graphId, string nodeId, double x, double y)
    {
        var id = ValidId(graphId, nameof(graphId));
        var normalizedNodeId = ValidId(nodeId, nameof(nodeId));

        lock (_lock)
        {
            var graph = FindGraphLocked(id);
            var node = graph?.Nodes.FirstOrDefault(candidate =>
                string.Equals(candidate.Id, normalizedNodeId, StringComparison.Ordinal));
            if (graph is null || node is null)
            {
                return false;
            }

            node.X = x;
            node.Y = y;
            node.UpdatedAt = DateTimeOffset.UtcNow;
            graph.UpdatedAt = node.UpdatedAt;
            ScheduleSaveLocked();
            return true;
        }
    }

    public bool DeleteNode(string graphId, string nodeId)
    {
        var id = ValidId(graphId, nameof(graphId));
        var normalizedNodeId = ValidId(nodeId, nameof(nodeId));

        lock (_lock)
        {
            var graph = FindGraphLocked(id);
            if (graph is null)
            {
                return false;
            }

            var removed = graph.Nodes.RemoveAll(node =>
                string.Equals(node.Id, normalizedNodeId, StringComparison.Ordinal)) > 0;
            if (!removed)
            {
                return false;
            }

            graph.Edges.RemoveAll(edge =>
                string.Equals(edge.FromId, normalizedNodeId, StringComparison.Ordinal)
                || string.Equals(edge.ToId, normalizedNodeId, StringComparison.Ordinal));
            graph.UpdatedAt = DateTimeOffset.UtcNow;
            ScheduleSaveLocked();
            return true;
        }
    }

    public ActionGraphEdge CreateEdge(string graphId, CreateActionGraphEdgeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ObjectDisposedException.ThrowIf(_disposed, this);
        var id = ValidId(graphId, nameof(graphId));
        var fromId = ValidId(request.FromId ?? "", nameof(request.FromId));
        var toId = ValidId(request.ToId ?? "", nameof(request.ToId));

        lock (_lock)
        {
            var graph = FindGraphLocked(id)
                ?? throw new ArgumentException($"Graph '{id}' does not exist.");
            if (graph.Edges.Count >= MaxEdgesPerGraph)
            {
                throw new ArgumentException($"Graph '{graph.Id}' already holds the maximum of {MaxEdgesPerGraph} edges.");
            }
            if (!graph.Nodes.Any(node => string.Equals(node.Id, fromId, StringComparison.Ordinal)))
            {
                throw new ArgumentException($"Node '{fromId}' does not exist in graph '{graph.Id}'.");
            }
            if (!graph.Nodes.Any(node => string.Equals(node.Id, toId, StringComparison.Ordinal)))
            {
                throw new ArgumentException($"Node '{toId}' does not exist in graph '{graph.Id}'.");
            }

            var edgeId = request.Id is null ? NewId() : ValidId(request.Id, nameof(request.Id));
            if (graph.Edges.Any(edge => string.Equals(edge.Id, edgeId, StringComparison.Ordinal)))
            {
                throw new ArgumentException($"Edge '{edgeId}' already exists in graph '{graph.Id}'.");
            }

            var edge = new ActionGraphEdge
            {
                Id = edgeId,
                FromId = fromId,
                ToId = toId,
                Label = Optional(request.Label, MaxLabelLength),
                Kind = Optional(request.Kind, 64),
                CreatedAt = DateTimeOffset.UtcNow
            };
            graph.Edges.Add(edge);
            graph.UpdatedAt = edge.CreatedAt;
            ScheduleSaveLocked();
            return Clone(edge);
        }
    }

    public bool DeleteEdge(string graphId, string edgeId)
    {
        var id = ValidId(graphId, nameof(graphId));
        var normalizedEdgeId = ValidId(edgeId, nameof(edgeId));

        lock (_lock)
        {
            var graph = FindGraphLocked(id);
            if (graph is null)
            {
                return false;
            }

            var removed = graph.Edges.RemoveAll(edge =>
                string.Equals(edge.Id, normalizedEdgeId, StringComparison.Ordinal)) > 0;
            if (removed)
            {
                graph.UpdatedAt = DateTimeOffset.UtcNow;
                ScheduleSaveLocked();
            }
            return removed;
        }
    }

    private ActionGraph GetOrCreateGraphLocked(string? requestedId, string? name)
    {
        var id = requestedId is null ? NewId() : ValidId(requestedId, "graphId");
        var existing = FindGraphLocked(id);
        if (existing is not null)
        {
            if (name is not null)
            {
                existing.Name = Required(name, MaxTitleLength, nameof(name));
                existing.UpdatedAt = DateTimeOffset.UtcNow;
                ScheduleSaveLocked();
            }
            return existing;
        }

        if (_document.Graphs.Count >= MaxGraphs)
        {
            throw new ArgumentException($"The maximum of {MaxGraphs} graphs already exists.");
        }

        var now = DateTimeOffset.UtcNow;
        var graph = new ActionGraph
        {
            Id = id,
            Name = Optional(name, MaxTitleLength) ?? id,
            CreatedAt = now,
            UpdatedAt = now
        };
        _document.Graphs.Add(graph);
        ScheduleSaveLocked();
        return graph;
    }

    private ActionGraph? FindGraphLocked(string id) =>
        _document.Graphs.FirstOrDefault(graph => string.Equals(graph.Id, id, StringComparison.Ordinal));

    private static List<ActionGraphNodeAction> NormalizedActions(List<ActionGraphNodeAction>? actions)
    {
        if (actions is null || actions.Count == 0)
        {
            return [];
        }
        if (actions.Count > MaxActionsPerNode)
        {
            throw new ArgumentException($"A node may hold at most {MaxActionsPerNode} actions.");
        }

        var normalized = new List<ActionGraphNodeAction>(actions.Count);
        foreach (var action in actions)
        {
            normalized.Add(new ActionGraphNodeAction
            {
                Id = string.IsNullOrWhiteSpace(action.Id) ? NewId() : ValidId(action.Id, "actionId"),
                Label = Required(action.Label, MaxLabelLength, "action label"),
                Cwd = Optional(action.Cwd, MaxReferenceLength),
                Profile = Optional(action.Profile, 64),
                Prompt = Optional(action.Prompt, MaxPromptLength),
                SessionName = Optional(action.SessionName, MaxTitleLength),
                SlashCommands = (action.SlashCommands ?? [])
                    .Where(static command => !string.IsNullOrWhiteSpace(command))
                    .Select(static command => command.Trim())
                    .Take(8)
                    .ToList()
            });
        }
        return normalized;
    }

    private static string NewId() => Guid.NewGuid().ToString("N")[..12];

    private static string ValidId(string? value, string field)
    {
        var trimmed = value?.Trim() ?? "";
        if (trimmed.Length is 0 or > 64 || !trimmed.All(static c =>
                char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))
        {
            throw new ArgumentException($"{field} must match [A-Za-z0-9._-] with 1-64 characters.");
        }
        return trimmed;
    }

    private static string Required(string? value, int maxLength, string field)
    {
        var trimmed = value?.Trim() ?? "";
        if (trimmed.Length == 0)
        {
            throw new ArgumentException($"{field} is required.");
        }
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private static string? Optional(string? value, int maxLength)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return null;
        }
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private static T Clone<T>(T value) where T : class
    {
        var json = JsonSerializer.Serialize(value, typeof(T), ActionGraphsJsonContext.Default);
        return (T)(JsonSerializer.Deserialize(json, typeof(T), ActionGraphsJsonContext.Default)
            ?? throw new InvalidOperationException("Clone round-trip failed."));
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                return;
            }

            var json = File.ReadAllText(_path);
            var document = JsonSerializer.Deserialize(json, ActionGraphsJsonContext.Default.ActionGraphsDocument);
            if (document is not null)
            {
                _document = document;
            }
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Could not load action graphs from '{_path}': {ex.Message}");
        }
    }

    private void ScheduleSaveLocked()
    {
        _savePending = true;
        _saveTimer.Change(SaveDebounceDelay, Timeout.InfiniteTimeSpan);
    }

    private void FlushPendingSave()
    {
        string? json = null;
        lock (_lock)
        {
            if (!_savePending || _disposed)
            {
                return;
            }
            _savePending = false;
            json = JsonSerializer.Serialize(_document, ActionGraphsJsonContext.Default.ActionGraphsDocument);
        }

        try
        {
            File.WriteAllText(_path, json);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Could not save action graphs to '{_path}': {ex.Message}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        lock (_lock)
        {
            _disposed = true;
        }
        _saveTimer.Dispose();
        FlushFinalSave();
    }

    private void FlushFinalSave()
    {
        string? json;
        lock (_lock)
        {
            if (!_savePending)
            {
                return;
            }
            _savePending = false;
            json = JsonSerializer.Serialize(_document, ActionGraphsJsonContext.Default.ActionGraphsDocument);
        }

        try
        {
            File.WriteAllText(_path, json);
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Could not save action graphs to '{_path}': {ex.Message}");
        }
    }
}
