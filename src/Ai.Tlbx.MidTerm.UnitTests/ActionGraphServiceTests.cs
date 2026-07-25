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

        Assert.True(service.SetNodePosition("g", "n", 300, 400));
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
