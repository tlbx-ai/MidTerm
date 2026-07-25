using System.Globalization;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Models.ActionGraphs;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.Data.Sqlite;

namespace Ai.Tlbx.MidTerm.Services;

/// <summary>
/// SQLite-backed store for agent-curated action graphs. Pure verbatim CRUD:
/// tlbx persists scopes, graphs, nodes, edges, positions, and launch specs —
/// it never derives meaning from them.
/// </summary>
public sealed class ActionGraphService : IDisposable
{
    internal const int MaxGraphs = 50;
    internal const int MaxScopes = 50;
    internal const int MaxNodesPerGraph = 500;
    internal const int MaxEdgesPerGraph = 1000;
    internal const int MaxActionsPerNode = 8;
    private const int MaxTitleLength = 256;
    private const int MaxStateLength = 256;
    private const int MaxHtmlLength = 65536;
    private const int MaxPromptLength = 8192;
    private const int MaxLabelLength = 128;
    private const int MaxReferenceLength = 4096;

    private readonly Lock _lock = new();
    private readonly SqliteConnection _connection;
    private bool _disposed;

    public ActionGraphService(SettingsService settingsService)
    {
        var databasePath = Path.Combine(settingsService.SettingsDirectory, "action-graphs.db");
        _connection = new SqliteConnection($"Data Source={databasePath}");
        _connection.Open();
        Execute("PRAGMA journal_mode=WAL;");
        CreateSchema();
        MigrateLegacyJsonDocument(Path.Combine(settingsService.SettingsDirectory, "action-graphs.json"));
    }

    // ----- Scopes -----

    public ActionGraphScopeListResponse ListScopes()
    {
        lock (_lock)
        {
            var scopes = new List<ActionGraphScope>();
            using var command = _connection.CreateCommand();
            command.CommandText = """
                SELECT s.id, s.name, s.created_at, COUNT(g.id)
                FROM scopes s LEFT JOIN graphs g ON g.scope_id = s.id
                GROUP BY s.id ORDER BY s.id = 'default' DESC, s.name COLLATE NOCASE
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                scopes.Add(new ActionGraphScope
                {
                    Id = reader.GetString(0),
                    Name = reader.GetString(1),
                    CreatedAt = ReadTimestamp(reader.GetString(2)),
                    GraphCount = reader.GetInt32(3)
                });
            }
            return new ActionGraphScopeListResponse { Scopes = scopes };
        }
    }

    public ActionGraphScope CreateScope(CreateActionGraphScopeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var id = request.Id is null ? NewId() : ValidId(request.Id, "scopeId");
        var name = Required(request.Name ?? id, MaxTitleLength, "scope name");

        lock (_lock)
        {
            ThrowIfDisposed();
            if (Scalar("SELECT COUNT(*) FROM scopes") >= MaxScopes)
            {
                throw new ArgumentException($"The maximum of {MaxScopes} scopes already exists.");
            }
            if (Scalar("SELECT COUNT(*) FROM scopes WHERE id = $id", ("$id", id)) > 0)
            {
                throw new ArgumentException($"Scope '{id}' already exists.");
            }

            var now = Now();
            Execute(
                "INSERT INTO scopes(id, name, created_at) VALUES($id, $name, $now)",
                ("$id", id), ("$name", name), ("$now", now));
            return new ActionGraphScope { Id = id, Name = name, CreatedAt = ReadTimestamp(now) };
        }
    }

    public bool RenameScope(string scopeId, RenameActionGraphScopeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var id = ValidId(scopeId, nameof(scopeId));
        if (string.Equals(id, ActionGraphScope.DefaultId, StringComparison.Ordinal))
        {
            throw new ArgumentException("The default scope cannot be renamed.");
        }
        var name = Required(request.Name, MaxTitleLength, "scope name");

        lock (_lock)
        {
            ThrowIfDisposed();
            return ExecuteRows("UPDATE scopes SET name = $name WHERE id = $id", ("$name", name), ("$id", id)) > 0;
        }
    }

    public bool DeleteScope(string scopeId)
    {
        var id = ValidId(scopeId, nameof(scopeId));
        if (string.Equals(id, ActionGraphScope.DefaultId, StringComparison.Ordinal))
        {
            throw new ArgumentException("The default scope cannot be deleted.");
        }

        lock (_lock)
        {
            ThrowIfDisposed();
            if (Scalar("SELECT COUNT(*) FROM graphs WHERE scope_id = $id", ("$id", id)) > 0)
            {
                throw new ArgumentException($"Scope '{id}' still contains graphs. Move or delete them first.");
            }
            return ExecuteRows("DELETE FROM scopes WHERE id = $id", ("$id", id)) > 0;
        }
    }

    // ----- Graphs -----

    public ActionGraphListResponse ListGraphs(string? scopeId = null)
    {
        var normalizedScope = scopeId is null ? null : ValidId(scopeId, nameof(scopeId));
        lock (_lock)
        {
            var graphs = new List<ActionGraphSummary>();
            using var command = _connection.CreateCommand();
            command.CommandText = """
                SELECT g.id, g.scope_id, g.name, g.updated_at,
                       (SELECT COUNT(*) FROM nodes n WHERE n.graph_id = g.id),
                       (SELECT COUNT(*) FROM edges e WHERE e.graph_id = g.id)
                FROM graphs g
                WHERE $scope IS NULL OR g.scope_id = $scope
                ORDER BY g.name COLLATE NOCASE
                """;
            command.Parameters.AddWithValue("$scope", (object?)normalizedScope ?? DBNull.Value);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                graphs.Add(new ActionGraphSummary
                {
                    Id = reader.GetString(0),
                    ScopeId = reader.GetString(1),
                    Name = reader.GetString(2),
                    UpdatedAt = ReadTimestamp(reader.GetString(3)),
                    NodeCount = reader.GetInt32(4),
                    EdgeCount = reader.GetInt32(5)
                });
            }
            return new ActionGraphListResponse { Graphs = graphs };
        }
    }

    public ActionGraph CreateGraph(CreateActionGraphRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        lock (_lock)
        {
            ThrowIfDisposed();
            var id = GetOrCreateGraphLocked(request.Id, request.Name, request.ScopeId);
            return GetGraphLocked(id)!;
        }
    }

    public bool DeleteGraph(string graphId)
    {
        var id = ValidId(graphId, nameof(graphId));
        lock (_lock)
        {
            ThrowIfDisposed();
            using var transaction = _connection.BeginTransaction();
            Execute("DELETE FROM node_actions WHERE graph_id = $id", ("$id", id));
            Execute("DELETE FROM edges WHERE graph_id = $id", ("$id", id));
            Execute("DELETE FROM nodes WHERE graph_id = $id", ("$id", id));
            var removed = ExecuteRows("DELETE FROM graphs WHERE id = $id", ("$id", id)) > 0;
            transaction.Commit();
            return removed;
        }
    }

    public ActionGraph? GetGraph(string graphId)
    {
        var id = ValidId(graphId, nameof(graphId));
        lock (_lock)
        {
            return GetGraphLocked(id);
        }
    }

    // ----- Nodes -----

    public ActionGraphNode CreateNode(string graphId, UpsertActionGraphNodeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var id = ValidId(graphId, nameof(graphId));

        lock (_lock)
        {
            ThrowIfDisposed();
            using var transaction = _connection.BeginTransaction();
            GetOrCreateGraphLocked(id, name: null, scopeId: null);
            if (Scalar("SELECT COUNT(*) FROM nodes WHERE graph_id = $g", ("$g", id)) >= MaxNodesPerGraph)
            {
                throw new ArgumentException($"Graph '{id}' already holds the maximum of {MaxNodesPerGraph} nodes.");
            }

            var nodeId = request.Id is null ? NewId() : ValidId(request.Id, nameof(request.Id));
            if (Scalar("SELECT COUNT(*) FROM nodes WHERE graph_id = $g AND id = $n", ("$g", id), ("$n", nodeId)) > 0)
            {
                throw new ArgumentException($"Node '{nodeId}' already exists in graph '{id}'.");
            }

            var now = Now();
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
                CreatedAt = ReadTimestamp(now),
                UpdatedAt = ReadTimestamp(now),
                Revision = 1
            };
            InsertNodeLocked(id, node, now);
            TouchGraphLocked(id, now);
            transaction.Commit();
            return node;
        }
    }

    public ActionGraphNode? UpdateNode(string graphId, string nodeId, UpsertActionGraphNodeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var id = ValidId(graphId, nameof(graphId));
        var normalizedNodeId = ValidId(nodeId, nameof(nodeId));

        lock (_lock)
        {
            ThrowIfDisposed();
            using var transaction = _connection.BeginTransaction();
            var node = ReadNodeLocked(id, normalizedNodeId);
            if (node is null)
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

            var now = Now();
            node.UpdatedAt = ReadTimestamp(now);
            node.Revision++;
            Execute("DELETE FROM node_actions WHERE graph_id = $g AND node_id = $n", ("$g", id), ("$n", normalizedNodeId));
            Execute("DELETE FROM nodes WHERE graph_id = $g AND id = $n", ("$g", id), ("$n", normalizedNodeId));
            InsertNodeLocked(id, node, now, node.CreatedAt.ToString("o", CultureInfo.InvariantCulture));
            TouchGraphLocked(id, now);
            transaction.Commit();
            return node;
        }
    }

    public bool SetNodePosition(string graphId, string nodeId, double x, double y)
    {
        var id = ValidId(graphId, nameof(graphId));
        var normalizedNodeId = ValidId(nodeId, nameof(nodeId));

        lock (_lock)
        {
            ThrowIfDisposed();
            var now = Now();
            var rows = ExecuteRows(
                "UPDATE nodes SET x = $x, y = $y, updated_at = $now WHERE graph_id = $g AND id = $n",
                ("$x", x), ("$y", y), ("$now", now), ("$g", id), ("$n", normalizedNodeId));
            if (rows > 0)
            {
                TouchGraphLocked(id, now);
            }
            return rows > 0;
        }
    }

    public bool DeleteNode(string graphId, string nodeId)
    {
        var id = ValidId(graphId, nameof(graphId));
        var normalizedNodeId = ValidId(nodeId, nameof(nodeId));

        lock (_lock)
        {
            ThrowIfDisposed();
            using var transaction = _connection.BeginTransaction();
            var removed = ExecuteRows(
                "DELETE FROM nodes WHERE graph_id = $g AND id = $n", ("$g", id), ("$n", normalizedNodeId)) > 0;
            if (removed)
            {
                Execute("DELETE FROM node_actions WHERE graph_id = $g AND node_id = $n", ("$g", id), ("$n", normalizedNodeId));
                Execute(
                    "DELETE FROM edges WHERE graph_id = $g AND (from_id = $n OR to_id = $n)",
                    ("$g", id), ("$n", normalizedNodeId));
                TouchGraphLocked(id, Now());
            }
            transaction.Commit();
            return removed;
        }
    }

    // ----- Edges -----

    public ActionGraphEdge CreateEdge(string graphId, CreateActionGraphEdgeRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var id = ValidId(graphId, nameof(graphId));
        var fromId = ValidId(request.FromId ?? "", nameof(request.FromId));
        var toId = ValidId(request.ToId ?? "", nameof(request.ToId));

        lock (_lock)
        {
            ThrowIfDisposed();
            using var transaction = _connection.BeginTransaction();
            if (Scalar("SELECT COUNT(*) FROM graphs WHERE id = $g", ("$g", id)) == 0)
            {
                throw new ArgumentException($"Graph '{id}' does not exist.");
            }
            if (Scalar("SELECT COUNT(*) FROM edges WHERE graph_id = $g", ("$g", id)) >= MaxEdgesPerGraph)
            {
                throw new ArgumentException($"Graph '{id}' already holds the maximum of {MaxEdgesPerGraph} edges.");
            }
            if (Scalar("SELECT COUNT(*) FROM nodes WHERE graph_id = $g AND id = $n", ("$g", id), ("$n", fromId)) == 0)
            {
                throw new ArgumentException($"Node '{fromId}' does not exist in graph '{id}'.");
            }
            if (Scalar("SELECT COUNT(*) FROM nodes WHERE graph_id = $g AND id = $n", ("$g", id), ("$n", toId)) == 0)
            {
                throw new ArgumentException($"Node '{toId}' does not exist in graph '{id}'.");
            }

            var edgeId = request.Id is null ? NewId() : ValidId(request.Id, nameof(request.Id));
            if (Scalar("SELECT COUNT(*) FROM edges WHERE graph_id = $g AND id = $e", ("$g", id), ("$e", edgeId)) > 0)
            {
                throw new ArgumentException($"Edge '{edgeId}' already exists in graph '{id}'.");
            }

            var now = Now();
            var edge = new ActionGraphEdge
            {
                Id = edgeId,
                FromId = fromId,
                ToId = toId,
                Label = Optional(request.Label, MaxLabelLength),
                Kind = Optional(request.Kind, 64),
                CreatedAt = ReadTimestamp(now)
            };
            Execute(
                """
                INSERT INTO edges(graph_id, id, from_id, to_id, label, kind, created_at)
                VALUES($g, $id, $from, $to, $label, $kind, $now)
                """,
                ("$g", id), ("$id", edge.Id), ("$from", edge.FromId), ("$to", edge.ToId),
                ("$label", (object?)edge.Label ?? DBNull.Value), ("$kind", (object?)edge.Kind ?? DBNull.Value),
                ("$now", now));
            TouchGraphLocked(id, now);
            transaction.Commit();
            return edge;
        }
    }

    public bool DeleteEdge(string graphId, string edgeId)
    {
        var id = ValidId(graphId, nameof(graphId));
        var normalizedEdgeId = ValidId(edgeId, nameof(edgeId));

        lock (_lock)
        {
            ThrowIfDisposed();
            var removed = ExecuteRows(
                "DELETE FROM edges WHERE graph_id = $g AND id = $e", ("$g", id), ("$e", normalizedEdgeId)) > 0;
            if (removed)
            {
                TouchGraphLocked(id, Now());
            }
            return removed;
        }
    }

    // ----- Internals -----

    private ActionGraph? GetGraphLocked(string id)
    {
        ActionGraph? graph = null;
        using (var command = _connection.CreateCommand())
        {
            command.CommandText = "SELECT id, scope_id, name, created_at, updated_at FROM graphs WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            using var reader = command.ExecuteReader();
            if (reader.Read())
            {
                graph = new ActionGraph
                {
                    Id = reader.GetString(0),
                    ScopeId = reader.GetString(1),
                    Name = reader.GetString(2),
                    CreatedAt = ReadTimestamp(reader.GetString(3)),
                    UpdatedAt = ReadTimestamp(reader.GetString(4))
                };
            }
        }
        if (graph is null)
        {
            return null;
        }

        using (var command = _connection.CreateCommand())
        {
            command.CommandText = """
                SELECT id, kind, title, state, html, x, y, width, color, url, path, host, project,
                       session_id, external_ref, date, source, created_at, updated_at, revision
                FROM nodes WHERE graph_id = $g ORDER BY created_at
                """;
            command.Parameters.AddWithValue("$g", id);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                graph.Nodes.Add(new ActionGraphNode
                {
                    Id = reader.GetString(0),
                    Kind = reader.GetString(1),
                    Title = reader.GetString(2),
                    State = reader.IsDBNull(3) ? null : reader.GetString(3),
                    Html = reader.IsDBNull(4) ? null : reader.GetString(4),
                    X = reader.GetDouble(5),
                    Y = reader.GetDouble(6),
                    Width = reader.IsDBNull(7) ? null : reader.GetDouble(7),
                    Color = reader.IsDBNull(8) ? null : reader.GetString(8),
                    Url = reader.IsDBNull(9) ? null : reader.GetString(9),
                    Path = reader.IsDBNull(10) ? null : reader.GetString(10),
                    Host = reader.IsDBNull(11) ? null : reader.GetString(11),
                    Project = reader.IsDBNull(12) ? null : reader.GetString(12),
                    SessionId = reader.IsDBNull(13) ? null : reader.GetString(13),
                    ExternalRef = reader.IsDBNull(14) ? null : reader.GetString(14),
                    Date = reader.IsDBNull(15) ? null : ReadTimestamp(reader.GetString(15)),
                    Source = reader.GetString(16),
                    CreatedAt = ReadTimestamp(reader.GetString(17)),
                    UpdatedAt = ReadTimestamp(reader.GetString(18)),
                    Revision = reader.GetInt32(19)
                });
            }
        }

        var actionsByNode = new Dictionary<string, List<ActionGraphNodeAction>>(StringComparer.Ordinal);
        using (var command = _connection.CreateCommand())
        {
            command.CommandText = """
                SELECT node_id, id, label, cwd, profile, prompt, session_name, slash_commands
                FROM node_actions WHERE graph_id = $g ORDER BY node_id, ord
                """;
            command.Parameters.AddWithValue("$g", id);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var nodeId = reader.GetString(0);
                if (!actionsByNode.TryGetValue(nodeId, out var actions))
                {
                    actions = [];
                    actionsByNode[nodeId] = actions;
                }
                actions.Add(new ActionGraphNodeAction
                {
                    Id = reader.GetString(1),
                    Label = reader.GetString(2),
                    Cwd = reader.IsDBNull(3) ? null : reader.GetString(3),
                    Profile = reader.IsDBNull(4) ? null : reader.GetString(4),
                    Prompt = reader.IsDBNull(5) ? null : reader.GetString(5),
                    SessionName = reader.IsDBNull(6) ? null : reader.GetString(6),
                    SlashCommands = DeserializeSlashCommands(reader.GetString(7))
                });
            }
        }
        foreach (var node in graph.Nodes)
        {
            if (actionsByNode.TryGetValue(node.Id, out var actions))
            {
                node.Actions = actions;
            }
        }

        using (var command = _connection.CreateCommand())
        {
            command.CommandText = """
                SELECT id, from_id, to_id, label, kind, created_at
                FROM edges WHERE graph_id = $g ORDER BY created_at
                """;
            command.Parameters.AddWithValue("$g", id);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                graph.Edges.Add(new ActionGraphEdge
                {
                    Id = reader.GetString(0),
                    FromId = reader.GetString(1),
                    ToId = reader.GetString(2),
                    Label = reader.IsDBNull(3) ? null : reader.GetString(3),
                    Kind = reader.IsDBNull(4) ? null : reader.GetString(4),
                    CreatedAt = ReadTimestamp(reader.GetString(5))
                });
            }
        }
        return graph;
    }

    private string GetOrCreateGraphLocked(string? requestedId, string? name, string? scopeId)
    {
        var id = requestedId is null ? NewId() : ValidId(requestedId, "graphId");
        var normalizedScope = scopeId is null ? null : ValidId(scopeId, "scopeId");
        var exists = Scalar("SELECT COUNT(*) FROM graphs WHERE id = $id", ("$id", id)) > 0;
        if (exists)
        {
            var now = Now();
            if (name is not null)
            {
                Execute(
                    "UPDATE graphs SET name = $name, updated_at = $now WHERE id = $id",
                    ("$name", Required(name, MaxTitleLength, nameof(name))), ("$now", now), ("$id", id));
            }
            if (normalizedScope is not null)
            {
                EnsureScopeExistsLocked(normalizedScope);
                Execute(
                    "UPDATE graphs SET scope_id = $scope, updated_at = $now WHERE id = $id",
                    ("$scope", normalizedScope), ("$now", now), ("$id", id));
            }
            return id;
        }

        if (Scalar("SELECT COUNT(*) FROM graphs") >= MaxGraphs)
        {
            throw new ArgumentException($"The maximum of {MaxGraphs} graphs already exists.");
        }

        var scope = normalizedScope ?? ActionGraphScope.DefaultId;
        EnsureScopeExistsLocked(scope);
        var createdAt = Now();
        Execute(
            """
            INSERT INTO graphs(id, scope_id, name, created_at, updated_at)
            VALUES($id, $scope, $name, $now, $now)
            """,
            ("$id", id), ("$scope", scope),
            ("$name", Optional(name, MaxTitleLength) ?? id), ("$now", createdAt));
        return id;
    }

    private void EnsureScopeExistsLocked(string scopeId)
    {
        if (Scalar("SELECT COUNT(*) FROM scopes WHERE id = $id", ("$id", scopeId)) == 0)
        {
            throw new ArgumentException($"Scope '{scopeId}' does not exist.");
        }
    }

    private void InsertNodeLocked(string graphId, ActionGraphNode node, string updatedAt, string? createdAt = null)
    {
        Execute(
            """
            INSERT INTO nodes(graph_id, id, kind, title, state, html, x, y, width, color, url, path, host,
                              project, session_id, external_ref, date, source, created_at, updated_at, revision)
            VALUES($g, $id, $kind, $title, $state, $html, $x, $y, $width, $color, $url, $path, $host,
                   $project, $sessionId, $externalRef, $date, $source, $createdAt, $updatedAt, $revision)
            """,
            ("$g", graphId), ("$id", node.Id), ("$kind", node.Kind), ("$title", node.Title),
            ("$state", (object?)node.State ?? DBNull.Value), ("$html", (object?)node.Html ?? DBNull.Value),
            ("$x", node.X), ("$y", node.Y), ("$width", (object?)node.Width ?? DBNull.Value),
            ("$color", (object?)node.Color ?? DBNull.Value), ("$url", (object?)node.Url ?? DBNull.Value),
            ("$path", (object?)node.Path ?? DBNull.Value), ("$host", (object?)node.Host ?? DBNull.Value),
            ("$project", (object?)node.Project ?? DBNull.Value),
            ("$sessionId", (object?)node.SessionId ?? DBNull.Value),
            ("$externalRef", (object?)node.ExternalRef ?? DBNull.Value),
            ("$date", node.Date is null
                ? DBNull.Value
                : node.Date.Value.ToString("o", CultureInfo.InvariantCulture)),
            ("$source", node.Source), ("$createdAt", createdAt ?? updatedAt), ("$updatedAt", updatedAt),
            ("$revision", node.Revision));

        var ord = 0;
        foreach (var action in node.Actions)
        {
            Execute(
                """
                INSERT INTO node_actions(graph_id, node_id, id, ord, label, cwd, profile, prompt, session_name, slash_commands)
                VALUES($g, $n, $id, $ord, $label, $cwd, $profile, $prompt, $sessionName, $slash)
                """,
                ("$g", graphId), ("$n", node.Id), ("$id", action.Id), ("$ord", ord++),
                ("$label", action.Label), ("$cwd", (object?)action.Cwd ?? DBNull.Value),
                ("$profile", (object?)action.Profile ?? DBNull.Value),
                ("$prompt", (object?)action.Prompt ?? DBNull.Value),
                ("$sessionName", (object?)action.SessionName ?? DBNull.Value),
                ("$slash", JsonSerializer.Serialize(action.SlashCommands, ActionGraphsJsonContext.Default.ListString)));
        }
    }

    private ActionGraphNode? ReadNodeLocked(string graphId, string nodeId)
    {
        var graph = GetGraphLocked(graphId);
        return graph?.Nodes.FirstOrDefault(node => string.Equals(node.Id, nodeId, StringComparison.Ordinal));
    }

    private void TouchGraphLocked(string graphId, string now)
    {
        Execute("UPDATE graphs SET updated_at = $now WHERE id = $id", ("$now", now), ("$id", graphId));
    }

    private void CreateSchema()
    {
        Execute(
            """
            CREATE TABLE IF NOT EXISTS scopes(
                id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS graphs(
                id TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT 'default',
                name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS nodes(
                graph_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
                state TEXT NULL, html TEXT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NULL,
                color TEXT NULL, url TEXT NULL, path TEXT NULL, host TEXT NULL, project TEXT NULL,
                session_id TEXT NULL, external_ref TEXT NULL, date TEXT NULL, source TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL,
                PRIMARY KEY(graph_id, id));
            CREATE TABLE IF NOT EXISTS node_actions(
                graph_id TEXT NOT NULL, node_id TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL,
                label TEXT NOT NULL, cwd TEXT NULL, profile TEXT NULL, prompt TEXT NULL,
                session_name TEXT NULL, slash_commands TEXT NOT NULL,
                PRIMARY KEY(graph_id, node_id, id));
            CREATE TABLE IF NOT EXISTS edges(
                graph_id TEXT NOT NULL, id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
                label TEXT NULL, kind TEXT NULL, created_at TEXT NOT NULL,
                PRIMARY KEY(graph_id, id));
            """);
        Execute(
            "INSERT OR IGNORE INTO scopes(id, name, created_at) VALUES('default', 'Default', $now)",
            ("$now", Now()));
    }

    /// <summary>One-time import of the pre-SQLite JSON document into the default scope.</summary>
    private void MigrateLegacyJsonDocument(string jsonPath)
    {
        try
        {
            if (!File.Exists(jsonPath) || Scalar("SELECT COUNT(*) FROM graphs") > 0)
            {
                return;
            }

            var document = JsonSerializer.Deserialize(
                File.ReadAllText(jsonPath),
                ActionGraphsJsonContext.Default.ActionGraphsDocument);
            if (document is not null)
            {
                using var transaction = _connection.BeginTransaction();
                foreach (var graph in document.Graphs)
                {
                    var createdAt = graph.CreatedAt.ToString("o", CultureInfo.InvariantCulture);
                    var updatedAt = graph.UpdatedAt.ToString("o", CultureInfo.InvariantCulture);
                    Execute(
                        """
                        INSERT OR IGNORE INTO graphs(id, scope_id, name, created_at, updated_at)
                        VALUES($id, 'default', $name, $created, $updated)
                        """,
                        ("$id", graph.Id), ("$name", graph.Name), ("$created", createdAt), ("$updated", updatedAt));
                    foreach (var node in graph.Nodes)
                    {
                        InsertNodeLocked(
                            graph.Id,
                            node,
                            node.UpdatedAt.ToString("o", CultureInfo.InvariantCulture),
                            node.CreatedAt.ToString("o", CultureInfo.InvariantCulture));
                    }
                    foreach (var edge in graph.Edges)
                    {
                        Execute(
                            """
                            INSERT OR IGNORE INTO edges(graph_id, id, from_id, to_id, label, kind, created_at)
                            VALUES($g, $id, $from, $to, $label, $kind, $created)
                            """,
                            ("$g", graph.Id), ("$id", edge.Id), ("$from", edge.FromId), ("$to", edge.ToId),
                            ("$label", (object?)edge.Label ?? DBNull.Value),
                            ("$kind", (object?)edge.Kind ?? DBNull.Value),
                            ("$created", edge.CreatedAt.ToString("o", CultureInfo.InvariantCulture)));
                    }
                }
                transaction.Commit();
            }

            File.Move(jsonPath, jsonPath + ".migrated", overwrite: true);
            Log.Info(() => $"Migrated action graphs from '{jsonPath}' into SQLite.");
        }
        catch (Exception ex)
        {
            Log.Warn(() => $"Could not migrate legacy action graphs from '{jsonPath}': {ex.Message}");
        }
    }

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

    private static List<string> DeserializeSlashCommands(string json)
    {
        try
        {
            return JsonSerializer.Deserialize(json, ActionGraphsJsonContext.Default.ListString) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private void Execute(string sql, params (string Name, object Value)[] parameters)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }
        command.ExecuteNonQuery();
    }

    private int ExecuteRows(string sql, params (string Name, object Value)[] parameters)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }
        return command.ExecuteNonQuery();
    }

    private long Scalar(string sql, params (string Name, object Value)[] parameters)
    {
        using var command = _connection.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }
        return (long)(command.ExecuteScalar() ?? 0L);
    }

    private static string Now() => DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture);

    private static DateTimeOffset ReadTimestamp(string value) =>
        DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);

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

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

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
        _connection.Dispose();
    }
}
