using Ai.Tlbx.MidTerm.Services.Boards;
using Ai.Tlbx.MidTerm.Services.WebPreview;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class BoardServiceTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"tlbx-boards-{Guid.NewGuid():N}");

    [Fact]
    public void ReopenRetainsViewportGeometryAndStructuredEntries()
    {
        string id;
        using (var store = new BoardService(_directory))
        {
            var board = store.Create(new() { Title = "Übersicht", PanX = -500.5, PanY = 800, Zoom = .35 });
            id = board.Id;
            store.WriteItem(id, null, new() { Item = new()
            {
                Kind = "timeline", Title = "Plan", X = -1200, Y = 555, Width = 600, Height = 300,
                Entries = [new() { Text = "Ship", Year = 2027, Week = 12, Quarter = 1, Date = "2027-03-22" }]
            }});
        }
        using var reopened = new BoardService(_directory);
        var loaded = Assert.IsType<BoardDocument>(reopened.Get(id));
        Assert.Equal("Übersicht", loaded.Title);
        Assert.Equal(-500.5, loaded.PanX);
        Assert.Equal(.35, loaded.Zoom);
        var item = Assert.Single(loaded.Items);
        Assert.Equal(-1200, item.X);
        Assert.Equal(600, item.Width);
        Assert.Equal(12, Assert.Single(item.Entries).Week);
        Assert.NotEmpty(item.Entries[0].Id);
    }

    [Fact]
    public void IndependentConnectionsRejectStaleEditsAndKeepOtherItems()
    {
        using var first = new BoardService(_directory);
        using var second = new BoardService(_directory);
        var board = first.Create(new());
        var note = first.WriteItem(board.Id, null, new() { Item = new() { Text = "Original" } })!;
        var other = first.WriteItem(board.Id, null, new() { Item = new() { Text = "Other" } })!;
        var changed = second.WriteItem(board.Id, note.Id, new() { ExpectedRevision = 1, Item = note with { Text = "Agent edit" } })!;
        Assert.Equal(2, changed.Revision);
        Assert.Throws<BoardConflictException>(() => first.WriteItem(board.Id, note.Id,
            new() { ExpectedRevision = 1, Item = note with { Text = "Stale UI" } }));
        Assert.Throws<BoardConflictException>(() => first.Delete(board.Id, note.Id, 1));
        first.Update(board.Id, new() { ExpectedRevision = 1, Zoom = 2 });
        var loaded = first.Get(board.Id)!;
        Assert.Equal("Agent edit", loaded.Items.Single(item => item.Id == note.Id).Text);
        Assert.Equal("Other", loaded.Items.Single(item => item.Id == other.Id).Text);
        Assert.Equal(2, loaded.Zoom);
        Assert.Throws<BoardConflictException>(() => second.Update(board.Id, new() { ExpectedRevision = 1, Title = "stale" }));
    }

    [Fact]
    public void DeleteCascadesWithoutTouchingAnotherBoard()
    {
        using var store = new BoardService(_directory);
        var board = store.Create(new());
        var other = store.Create(new() { Title = "Keep" });
        store.WriteItem(board.Id, null, new());
        Assert.Throws<ArgumentException>(() => store.Delete(board.Id, null, null));
        Assert.True(store.Delete(board.Id, null, 1));
        Assert.Null(store.Get(board.Id));
        Assert.Equal(other.Id, Assert.Single(store.List()).Id);
        Assert.Null(store.WriteItem(board.Id, null, new()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(9)]
    [InlineData(double.NaN)]
    public void InvalidZoomCannotCorruptStoredViewport(double zoom)
    {
        using var store = new BoardService(_directory);
        var board = store.Create(new());
        Assert.Throws<ArgumentException>(() => store.Update(board.Id, new() { ExpectedRevision = 1, Zoom = zoom }));
        Assert.Equal(1, store.Get(board.Id)!.Zoom);
        Assert.Equal(1, store.Get(board.Id)!.Revision);
    }

    [Fact]
    public void LocalFilesStayInsideRegisteredRoot()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllText(Path.Combine(_directory, "index.html"), "<button>Test</button>");
        File.WriteAllText(Path.Combine(_directory, "app.js"), "document.title='ok'");
        Assert.Equal(Path.Combine(_directory, "index.html"), WebPreviewLocalDirectory.ResolveFile(_directory, ""));
        Assert.Equal(Path.Combine(_directory, "app.js"), WebPreviewLocalDirectory.ResolveFile(_directory, "app.js"));
        Assert.Null(WebPreviewLocalDirectory.ResolveFile(_directory, "../outside.txt"));
        Assert.Null(WebPreviewLocalDirectory.ResolveFile(_directory, "..\\outside.txt"));
        Assert.Null(WebPreviewLocalDirectory.ResolveFile(_directory, "index.html:secret"));
        Assert.Null(WebPreviewLocalDirectory.ResolveFile(_directory, Path.GetFullPath(_directory)));
        Assert.Null(WebPreviewLocalDirectory.ResolveFile(_directory, "missing.html"));
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}
