using Ai.Tlbx.MidTerm.Models.ActionGraphs;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ActionGraphServiceTests : IDisposable
{
    private readonly string _tempDir;

    public ActionGraphServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_action_graph_tests_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
    }

    [Fact]
    public void CreatesNodesWithAutoCreatedGraphAndRoundTripsTypedFields()
    {
        using var service = CreateService();

        var node = service.CreateNode("strands", new UpsertActionGraphNodeRequest
        {
            Id = "dai",
            Kind = ActionGraphNodeKinds.Project,
            Title = "DAI",
            State = "v1.7.3 live",
            Html = "<p>Rich <b>HTML</b> body</p>",
            X = 120,
            Y = 80,
            Width = 260,
            Height = 140,
            Url = "https://dai.tlbx.ai",
            Path = @"Q:\repos\DAI",
            Project = "DAI",
            Date = DateTimeOffset.Parse("2026-07-30T09:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
            Actions =
            [
                new ActionGraphNodeAction
                {
                    Label = "Continue",
                    Cwd = @"Q:\repos\Jpa",
                    Profile = "claude",
                    Prompt = "Wir arbeiten an DAI weiter."
                }
            ]
        });

        var graph = service.GetGraph("strands");

        Assert.NotNull(graph);
        Assert.Equal("strands", graph!.Id);
        var loaded = Assert.Single(graph.Nodes);
        Assert.Equal("dai", loaded.Id);
        Assert.Equal(ActionGraphNodeKinds.Project, loaded.Kind);
        Assert.Equal("v1.7.3 live", loaded.State);
        Assert.Equal("<p>Rich <b>HTML</b> body</p>", loaded.Html);
        Assert.Equal(120, loaded.X);
        Assert.Equal(80, loaded.Y);
        Assert.Equal(260, loaded.Width);
        Assert.Equal(140, loaded.Height);
        var action = Assert.Single(loaded.Actions);
        Assert.Equal("Continue", action.Label);
        Assert.False(string.IsNullOrEmpty(action.Id));
        Assert.Equal(1, node.Revision);
    }

    [Fact]
    public void UpdatesKeepManualPositionUnlessExplicitlyMoved()
    {
        using var service = CreateService();
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "n", Title = "Node", X = 10, Y = 20 });

        Assert.NotNull(service.SetNodePosition("g", "n", 300, 400));
        var afterContentUpdate = service.UpdateNode("g", "n", new UpsertActionGraphNodeRequest
        {
            State = "updated by agent"
        });
        var afterExplicitMove = service.UpdateNode("g", "n", new UpsertActionGraphNodeRequest
        {
            X = 55,
            Y = 66
        });

        Assert.NotNull(afterContentUpdate);
        Assert.Equal(300, afterContentUpdate!.X);
        Assert.Equal(400, afterContentUpdate.Y);
        Assert.Equal("updated by agent", afterContentUpdate.State);
        Assert.NotNull(afterExplicitMove);
        Assert.Equal(55, afterExplicitMove!.X);
        Assert.Equal(66, afterExplicitMove.Y);
    }

    [Fact]
    public void DeletingANodeRemovesItsEdges()
    {
        using var service = CreateService();
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "a", Title = "A" });
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "b", Title = "B" });
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "c", Title = "C" });
        service.CreateEdge("g", new CreateActionGraphEdgeRequest { FromId = "a", ToId = "b" });
        var surviving = service.CreateEdge("g", new CreateActionGraphEdgeRequest { FromId = "b", ToId = "c" });

        Assert.True(service.DeleteNode("g", "a"));

        var graph = service.GetGraph("g");
        Assert.NotNull(graph);
        Assert.Equal(2, graph!.Nodes.Count);
        var edge = Assert.Single(graph.Edges);
        Assert.Equal(surviving.Id, edge.Id);
    }

    [Fact]
    public void RejectsEdgesToUnknownNodesAndDuplicateNodeIds()
    {
        using var service = CreateService();
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "a", Title = "A" });

        Assert.Throws<ArgumentException>(() =>
            service.CreateEdge("g", new CreateActionGraphEdgeRequest { FromId = "a", ToId = "ghost" }));
        Assert.Throws<ArgumentException>(() =>
            service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "a", Title = "Duplicate" }));
        Assert.Throws<ArgumentException>(() =>
            service.CreateNode("bad id!", new UpsertActionGraphNodeRequest { Title = "X" }));
    }

    [Fact]
    public void PersistsGraphsAcrossServiceRestarts()
    {
        using (var service = CreateService())
        {
            service.CreateGraph(new CreateActionGraphRequest { Id = "ops", Name = "Ops board" });
            service.CreateNode("ops", new UpsertActionGraphNodeRequest
            {
                Id = "api",
                Kind = ActionGraphNodeKinds.Service,
                Title = "API gateway"
            });
        }

        using var reloaded = CreateService();
        var graph = reloaded.GetGraph("ops");

        Assert.NotNull(graph);
        Assert.Equal("Ops board", graph!.Name);
        var node = Assert.Single(graph.Nodes);
        Assert.Equal("api", node.Id);
        Assert.Equal(ActionGraphNodeKinds.Service, node.Kind);
    }

    [Fact]
    public void ListsGraphsWithCountsAndDeletesWholeGraphs()
    {
        using var service = CreateService();
        service.CreateNode("one", new UpsertActionGraphNodeRequest { Id = "n1", Title = "N1" });
        service.CreateNode("two", new UpsertActionGraphNodeRequest { Id = "n2", Title = "N2" });

        var list = service.ListGraphs();
        Assert.Equal(2, list.Graphs.Count);
        Assert.All(list.Graphs, summary => Assert.Equal(1, summary.NodeCount));

        Assert.True(service.DeleteGraph("one"));
        Assert.False(service.DeleteGraph("one"));
        Assert.Single(service.ListGraphs().Graphs);
    }

    [Fact]
    public void ScopesPartitionGraphsAndProtectTheDefaultScope()
    {
        using var service = CreateService();
        var work = service.CreateScope(new CreateActionGraphScopeRequest { Id = "work", Name = "Work" });
        service.CreateGraph(new CreateActionGraphRequest { Id = "office", ScopeId = "work" });
        service.CreateNode("private", new UpsertActionGraphNodeRequest { Id = "n", Title = "Default scope node" });

        var scopes = service.ListScopes().Scopes;
        var workGraphs = service.ListGraphs("work").Graphs;
        var allGraphs = service.ListGraphs().Graphs;

        Assert.Equal("work", work.Id);
        Assert.Equal(2, scopes.Count);
        Assert.Equal(ActionGraphScope.DefaultId, scopes[0].Id);
        var officeGraph = Assert.Single(workGraphs);
        Assert.Equal("office", officeGraph.Id);
        Assert.Equal(2, allGraphs.Count);
        Assert.Equal(ActionGraphScope.DefaultId, allGraphs.Single(g => g.Id == "private").ScopeId);

        Assert.Throws<ArgumentException>(() => service.DeleteScope(ActionGraphScope.DefaultId));
        Assert.Throws<ArgumentException>(() =>
            service.RenameScope(ActionGraphScope.DefaultId, new RenameActionGraphScopeRequest { Name = "X" }));
        Assert.Throws<ArgumentException>(() => service.DeleteScope("work"));
        Assert.True(service.DeleteGraph("office"));
        Assert.True(service.DeleteScope("work"));
    }

    [Fact]
    public void MigratesLegacyJsonDocumentIntoSqliteOnce()
    {
        var jsonPath = Path.Combine(_tempDir, "action-graphs.json");
        File.WriteAllText(jsonPath, """
            {
              "graphs": [
                {
                  "id": "legacy",
                  "name": "Legacy board",
                  "nodes": [
                    { "id": "a", "kind": "project", "title": "A", "x": 10, "y": 20,
                      "actions": [{ "id": "act1", "label": "Go", "cwd": "C:/work", "slashCommands": ["status"] }],
                      "source": "agent", "createdAt": "2026-07-20T10:00:00+00:00", "updatedAt": "2026-07-20T10:00:00+00:00", "revision": 3 }
                  ],
                  "edges": [],
                  "createdAt": "2026-07-20T10:00:00+00:00",
                  "updatedAt": "2026-07-20T10:00:00+00:00"
                }
              ]
            }
            """);

        using var service = CreateService();
        var graph = service.GetGraph("legacy");

        Assert.NotNull(graph);
        Assert.Equal(ActionGraphScope.DefaultId, graph!.ScopeId);
        var node = Assert.Single(graph.Nodes);
        Assert.Equal(3, node.Revision);
        var action = Assert.Single(node.Actions);
        Assert.Equal("Go", action.Label);
        Assert.Equal(["status"], action.SlashCommands);
        Assert.False(File.Exists(jsonPath));
        Assert.True(File.Exists(jsonPath + ".migrated"));
    }

    [Fact]
    public void RejectsStaleNodeContentAndPositionUpdates()
    {
        using var service = CreateService();
        var created = service.CreateNode("g", new UpsertActionGraphNodeRequest
        {
            Id = "n",
            Title = "Node"
        });

        var updated = service.UpdateNode("g", "n", new UpsertActionGraphNodeRequest
        {
            State = "claimed",
            ExpectedRevision = created.Revision
        });

        Assert.NotNull(updated);
        Assert.Equal(2, updated!.Revision);
        var staleContent = Assert.Throws<ActionGraphConflictException>(() =>
            service.UpdateNode("g", "n", new UpsertActionGraphNodeRequest
            {
                State = "overwritten",
                ExpectedRevision = created.Revision
            }));
        Assert.Equal(2, staleContent.CurrentRevision);

        var moved = service.SetNodePosition("g", "n", 100, 200, expectedRevision: updated.Revision);
        Assert.NotNull(moved);
        Assert.Equal(3, moved!.Revision);
        Assert.Throws<ActionGraphConflictException>(() =>
            service.SetNodePosition("g", "n", 300, 400, expectedRevision: updated.Revision));
    }

    [Fact]
    public void RejectsStaleGraphMutations()
    {
        using var service = CreateService();
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "a", Title = "A" });
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "b", Title = "B" });
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "c", Title = "C" });
        var revision = service.GetGraph("g")!.Revision;

        service.CreateEdge("g", new CreateActionGraphEdgeRequest
        {
            FromId = "a",
            ToId = "b",
            ExpectedGraphRevision = revision
        });

        var conflict = Assert.Throws<ActionGraphConflictException>(() =>
            service.CreateEdge("g", new CreateActionGraphEdgeRequest
            {
                FromId = "b",
                ToId = "c",
                ExpectedGraphRevision = revision
            }));
        Assert.True(conflict.CurrentRevision > revision);
    }

    [Fact]
    public void RejectsStaleDestructiveMutations()
    {
        using var service = CreateService();
        var node = service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "a", Title = "A" });
        var graphRevision = service.GetGraph("g")!.Revision;
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "b", Title = "B" });

        Assert.Throws<ActionGraphConflictException>(() =>
            service.DeleteNode("g", "a", node.Revision, graphRevision));
        Assert.Throws<ActionGraphConflictException>(() =>
            service.DeleteGraph("g", graphRevision));
        Assert.Equal(2, service.GetGraph("g")!.Nodes.Count);
    }

    [Fact]
    public void RoundTripsZoomHintsFreeFormCommandsAndMultipleSessionBindings()
    {
        using var service = CreateService();
        var node = service.CreateNode("g", new UpsertActionGraphNodeRequest
        {
            Id = "work",
            Title = "Investigate",
            MinZoom = 0.35,
            MaxZoom = 2.5,
            Pinned = true,
            Attention = true,
            Hidden = true,
            Actions =
            [
                new ActionGraphNodeAction
                {
                    Label = "Run",
                    Command = "future-agent --mode build",
                    Prompt = "Inspect the graph context."
                }
            ]
        });
        var graphRevision = service.GetGraph("g")!.Revision;

        service.BindSession("g", "work", new BindActionGraphSessionRequest
        {
            SessionId = "session-a",
            Role = "worker",
            ExpectedGraphRevision = graphRevision
        });
        service.BindSession("g", "work", new BindActionGraphSessionRequest
        {
            SessionId = "session-b",
            Role = "reviewer"
        });

        var loaded = Assert.Single(service.GetGraph("g")!.Nodes);
        Assert.Equal(0.35, loaded.MinZoom);
        Assert.Equal(2.5, loaded.MaxZoom);
        Assert.True(loaded.Pinned);
        Assert.True(loaded.Attention);
        Assert.True(loaded.Hidden);
        Assert.Equal("future-agent --mode build", Assert.Single(loaded.Actions).Command);
        Assert.Equal(2, loaded.Sessions.Count);
        Assert.Contains(loaded.Sessions, binding => binding.SessionId == "session-a" && binding.Role == "worker");
        Assert.Contains(loaded.Sessions, binding => binding.SessionId == "session-b" && binding.Role == "reviewer");
        Assert.True(loaded.Revision > node.Revision);
    }

    [Fact]
    public void OrganizesFromStructureWhilePreservingPinnedNodesAndConcurrency()
    {
        using var service = CreateService();
        service.CreateNode("g", new UpsertActionGraphNodeRequest
        {
            Id = "a",
            Title = "A",
            X = 900,
            Y = 700,
            Pinned = true
        });
        service.CreateNode("g", new UpsertActionGraphNodeRequest
        {
            Id = "b",
            Title = "B",
            X = 900,
            Y = 700
        });
        service.CreateEdge("g", new CreateActionGraphEdgeRequest { FromId = "a", ToId = "b" });
        var revision = service.GetGraph("g")!.Revision;

        var arranged = service.OrganizeGraph("g", revision);

        Assert.NotNull(arranged);
        Assert.Equal(900, arranged!.Nodes.Single(node => node.Id == "a").X);
        Assert.NotEqual(900, arranged.Nodes.Single(node => node.Id == "b").X);
        Assert.True(arranged.Revision > revision);
        Assert.Throws<ActionGraphConflictException>(() => service.OrganizeGraph("g", revision));
    }

    [Fact]
    public void ReturnsBoundedGraphAwareNodeContext()
    {
        using var service = CreateService();
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "a", Title = "A" });
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "b", Title = "B" });
        service.CreateNode("g", new UpsertActionGraphNodeRequest { Id = "c", Title = "C" });
        service.CreateEdge("g", new CreateActionGraphEdgeRequest { FromId = "a", ToId = "b" });
        service.CreateEdge("g", new CreateActionGraphEdgeRequest { FromId = "b", ToId = "c" });

        var context = service.GetNodeContext("g", "a", depth: 1, limit: 10);

        Assert.NotNull(context);
        Assert.Equal("a", context!.Anchor.Id);
        Assert.Equal(["a", "b"], context.Nodes.Select(node => node.Id).ToArray());
        Assert.Single(context.Edges);
        Assert.Equal(service.GetGraph("g")!.Revision, context.GraphRevision);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_tempDir))
            {
                Directory.Delete(_tempDir, recursive: true);
            }
        }
        catch
        {
        }
    }

    private ActionGraphService CreateService() => new(new SettingsService(_tempDir));
}
