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

    [Fact]
    public void IndependentViewsPersistCameraWithoutConflictingWithDocumentEdits()
    {
        using var first = new BoardService(_directory);
        using var second = new BoardService(_directory);
        var board = first.Create(new() { Title = "Before" });
        Assert.True(second.UpdateViewport(board.Id, new(-120, 450, .25)));
        first.Update(board.Id, new() { ExpectedRevision = 1, Title = "After" });
        var saved = second.Get(board.Id)!;
        Assert.Equal("After", saved.Title);
        Assert.Equal(2, saved.Revision);
        Assert.Equal(-120, saved.PanX);
        Assert.Equal(.25, saved.Zoom);
        Assert.True(first.UpdateViewport(board.Id, new(80, 90, 2)));
        Assert.Equal(2, second.Get(board.Id)!.Revision);
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

    [Fact]
    public void CalendarUsesMondayGridAndCorrectIsoYearAtNewYear()
    {
        var month = BoardCalendar.Month("2021-01");
        Assert.Equal(42, month.Days.Count);
        Assert.Equal("2020-12-28", month.Days[0].Date);
        Assert.Equal(2020, month.Days[0].IsoYear);
        Assert.Equal(53, month.Days[0].Week);
        var january = month.Days.Single(day => day.Date == "2021-01-01");
        Assert.True(january.InMonth);
        Assert.Equal(2020, january.IsoYear);
        Assert.Equal(1, january.Quarter);
        Assert.Equal(1, month.Days.Single(day => day.Date == "2021-01-04").Week);
        Assert.Throws<ArgumentException>(() => BoardCalendar.Month("2021-13"));
    }

    [Fact]
    public void LongTermEntryRejectsNonexistentIsoWeek()
    {
        using var store = new BoardService(_directory);
        var board = store.Create(new());
        Assert.Throws<ArgumentException>(() => store.WriteItem(board.Id, null, new()
        {
            Item = new() { Kind = "timeline", Entries = [new() { Year = 2021, Week = 53 }] }
        }));
        Assert.NotNull(store.WriteItem(board.Id, null, new()
        {
            Item = new() { Kind = "timeline", Entries = [new() { Year = 2020, Week = 53 }] }
        }));
    }

    [Fact]
    public void LaunchReceiptIsIdempotentAndKeepsExactContextAndSession()
    {
        using var store = new BoardService(_directory);
        var board = store.Create(new() { WorkingDirectory = _directory, LaunchCommand = "codex --model test", SessionProfile = "codex" });
        var item = store.WriteItem(board.Id, null, new() { Item = new() { Title = "Plan", Text = "Original instructions", Prompt = "Keep this intact", Entries = [new() { Text = "Ship", Year = 2027, Quarter = 2 }] } })!;
        var request = new BoardLaunchRequest { RequestId = Guid.NewGuid().ToString("N"), ExpectedRevision = item.Revision, EntryId = item.Entries[0].Id };
        var started = store.BeginLaunch(board.Id, item.Id, request, "https://example.test:2100");
        Assert.True(started.Created);
        Assert.Equal("codex --model test", started.Launch.LaunchCommand);
        Assert.Contains($"/?board={board.Id}&item={item.Id}&entry={item.Entries[0].Id}", started.Launch.Prompt, StringComparison.Ordinal);
        Assert.Contains($"mt board item {board.Id} {item.Id}", started.Launch.Prompt, StringComparison.Ordinal);
        Assert.Contains("Keep this intact", started.Launch.Prompt, StringComparison.Ordinal);
        var submitted = store.UpdateLaunch(started.Launch, "submitted", "session-123");
        var duplicate = store.BeginLaunch(board.Id, item.Id, request, "https://example.test:2100");
        Assert.False(duplicate.Created);
        Assert.Equal(submitted, duplicate.Launch);
        Assert.Throws<ArgumentException>(() => store.BeginLaunch(board.Id, item.Id, request with { LaunchCommand = "different" }, "https://example.test"));
        Assert.Equal("session-123", Assert.Single(store.GetItem(board.Id, item.Id)!.Launches).SessionId);
        Assert.False(store.GetItem(board.Id, item.Id)!.Entries[0].Done);
        store.Delete(board.Id, item.Id, item.Revision);
        Assert.Empty(store.ListLaunches(board.Id));
    }

    [Fact]
    public void LaunchRejectsStaleRevisionMissingTaskAndInvalidConfiguration()
    {
        using var store = new BoardService(_directory);
        var board = store.Create(new());
        var item = store.WriteItem(board.Id, null, new())!;
        Assert.Throws<BoardConflictException>(() => store.BeginLaunch(board.Id, item.Id, new() { ExpectedRevision = 999 }, "https://example.test"));
        Assert.Throws<ArgumentException>(() => store.BeginLaunch(board.Id, item.Id, new() { EntryId = "missing" }, "https://example.test"));
        Assert.Throws<ArgumentException>(() => store.BeginLaunch(board.Id, item.Id, new(), "https://example.test"));
        var launch = store.BeginLaunch(board.Id, item.Id, new() { WorkingDirectory = _directory, LaunchCommand = "custom-agent" }, "https://example.test");
        Assert.Null(launch.Launch.EntryId);
        Assert.Equal("custom-agent", launch.Launch.LaunchCommand);
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}
