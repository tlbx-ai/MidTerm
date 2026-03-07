using System.Collections.Concurrent;
using System.Reflection;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TtyHostSessionManagerStateTests
{
    [Fact]
    public async Task SetBookmarkId_UnknownSession_ReturnsFalse()
    {
        await using var manager = CreateManager();

        var ok = manager.SetBookmarkId("missing", "bookmark-1");

        Assert.False(ok);
    }

    [Fact]
    public async Task SetBookmarkId_ExistingSession_PopulatesSessionListBookmark()
    {
        await using var manager = CreateManager();
        AddCachedSession(manager, "s1");

        var ok = manager.SetBookmarkId("s1", "history-123");

        Assert.True(ok);
        var dto = manager.GetSessionList().Sessions.Single(s => s.Id == "s1");
        Assert.Equal("history-123", dto.BookmarkId);
    }

    [Fact]
    public async Task ClearBookmarksByHistoryId_RemovesMatchingBookmarksOnly()
    {
        await using var manager = CreateManager();
        AddCachedSession(manager, "s1");
        AddCachedSession(manager, "s2");
        AddCachedSession(manager, "s3");
        manager.SetBookmarkId("s1", "history-a");
        manager.SetBookmarkId("s2", "history-b");
        manager.SetBookmarkId("s3", "history-a");

        var removed = manager.ClearBookmarksByHistoryId("history-a");

        Assert.Equal(2, removed);
        var list = manager.GetSessionList().Sessions.ToDictionary(s => s.Id, s => s.BookmarkId);
        Assert.Null(list["s1"]);
        Assert.Equal("history-b", list["s2"]);
        Assert.Null(list["s3"]);
    }

    [Fact]
    public async Task ClearBookmarksByHistoryId_Whitespace_ReturnsZero()
    {
        await using var manager = CreateManager();
        AddCachedSession(manager, "s1");
        manager.SetBookmarkId("s1", "history-a");

        Assert.Equal(0, manager.ClearBookmarksByHistoryId(" "));
        Assert.Equal("history-a", manager.GetSessionList().Sessions.Single().BookmarkId);
    }

    [Fact]
    public async Task SetSessionNameAsync_AutoMode_StoresTerminalTitleOnly()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        info.Name = "Manual Name";
        info.ManuallyNamed = true;
        AddDisconnectedClient(manager, "s1");

        var ok = await manager.SetSessionNameAsync("s1", "Terminal Title", isManual: false);

        Assert.True(ok);
        Assert.Equal("Terminal Title", info.TerminalTitle);
        Assert.Equal("Manual Name", info.Name);
        Assert.True(info.ManuallyNamed);
    }

    [Fact]
    public async Task SetSessionNameAsync_AutoMode_WhitespaceClearsTerminalTitle()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        info.TerminalTitle = "Old";
        AddDisconnectedClient(manager, "s1");

        var ok = await manager.SetSessionNameAsync("s1", "   ", isManual: false);

        Assert.True(ok);
        Assert.Null(info.TerminalTitle);
    }

    [Fact]
    public async Task SetSessionNameAsync_AutoMode_ShellPathClearsTerminalTitle()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        AddDisconnectedClient(manager, "s1");

        var ok = await manager.SetSessionNameAsync("s1", @"C:\Program Files\PowerShell\7\pwsh.exe", isManual: false);

        Assert.True(ok);
        Assert.Null(info.TerminalTitle);
    }

    [Fact]
    public async Task SetSessionNameAsync_ManualMode_WhenSetNameFails_DoesNotUpdateName()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        info.Name = "Before";
        AddDisconnectedClient(manager, "s1");

        var ok = await manager.SetSessionNameAsync("s1", "After", isManual: true);

        Assert.False(ok);
        Assert.Equal("Before", info.Name);
    }

    [Fact]
    public async Task OscTitleSequence_BelTerminator_UpdatesTerminalTitle()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        var data = Encoding.UTF8.GetBytes("\u001b]2;Build Running\u0007");

        InvokeHandleClientOutput(manager, "s1", data);

        Assert.Equal("Build Running", info.TerminalTitle);
    }

    [Fact]
    public async Task OscTitleSequence_StTerminator_UpdatesTerminalTitle()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        var data = Encoding.UTF8.GetBytes("\u001b]0;Window Name\u001b\\");

        InvokeHandleClientOutput(manager, "s1", data);

        Assert.Equal("Window Name", info.TerminalTitle);
    }

    [Fact]
    public async Task OscTitleSequence_ShellExecutablePath_ClearsTerminalTitle()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        var data = Encoding.UTF8.GetBytes("\u001b]2;C:\\Program Files\\PowerShell\\7\\pwsh.exe\u0007");

        InvokeHandleClientOutput(manager, "s1", data);

        Assert.Null(info.TerminalTitle);
    }

    [Fact]
    public async Task OscCwdSequence_FileUri_UpdatesCurrentDirectoryAndFiresEvent()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        var seen = new List<string>();
        manager.OnCwdChanged += (_, cwd) => seen.Add(cwd);

        var data = Encoding.UTF8.GetBytes("\u001b]7;file://localhost/C:/Repo%20One\u0007");
        InvokeHandleClientOutput(manager, "s1", data);

        var expected = OperatingSystem.IsWindows() ? @"C:\Repo One" : "/C:/Repo One";
        Assert.Equal(expected, info.CurrentDirectory);
        Assert.Single(seen);
        Assert.Equal(expected, seen[0]);
    }

    [Fact]
    public async Task OscCwdSequence_NonFileUri_IsIgnored()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        info.CurrentDirectory = @"C:\existing";
        var calls = 0;
        manager.OnCwdChanged += (_, _) => calls++;

        var data = Encoding.UTF8.GetBytes("\u001b]7;https://example.com/repo\u0007");
        InvokeHandleClientOutput(manager, "s1", data);

        Assert.Equal(@"C:\existing", info.CurrentDirectory);
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task OscCwdSequence_SameDirectoryDifferentCase_DoesNotFireDuplicateEvent()
    {
        await using var manager = CreateManager();
        var info = AddCachedSession(manager, "s1");
        info.CurrentDirectory = OperatingSystem.IsWindows() ? @"C:\Repo One" : "/C:/Repo One";
        var calls = 0;
        manager.OnCwdChanged += (_, _) => calls++;

        var data = Encoding.UTF8.GetBytes("\u001b]7;file://localhost/c:/repo%20one\u0007");
        InvokeHandleClientOutput(manager, "s1", data);

        Assert.Equal(0, calls);
    }

    [Fact]
    public void MergeCachedFields_PreservesMtOwnedAndSparseFields()
    {
        var refreshed = new SessionInfo
        {
            Id = "s1",
            Name = null,
            CurrentDirectory = null,
            ForegroundPid = null,
            ForegroundName = null,
            ForegroundCommandLine = null
        };
        var existing = new SessionInfo
        {
            Id = "s1",
            Name = "User Name",
            TerminalTitle = "Terminal Name",
            ManuallyNamed = true,
            CurrentDirectory = @"C:\Repo",
            ForegroundPid = 1234,
            ForegroundName = "dotnet",
            ForegroundCommandLine = "dotnet test"
        };

        InvokeMergeCachedFields(refreshed, existing);

        Assert.True(refreshed.ManuallyNamed);
        Assert.Equal("Terminal Name", refreshed.TerminalTitle);
        Assert.Equal("User Name", refreshed.Name);
        Assert.Equal(@"C:\Repo", refreshed.CurrentDirectory);
        Assert.Equal(1234, refreshed.ForegroundPid);
        Assert.Equal("dotnet", refreshed.ForegroundName);
        Assert.Equal("dotnet test", refreshed.ForegroundCommandLine);
    }

    private static TtyHostSessionManager CreateManager()
    {
        return new TtyHostSessionManager(expectedVersion: "1.0.0", minCompatibleVersion: "1.0.0");
    }

    private static SessionInfo AddCachedSession(TtyHostSessionManager manager, string sessionId)
    {
        var info = new SessionInfo
        {
            Id = sessionId,
            Pid = 42,
            HostPid = 43,
            ShellType = "Pwsh",
            CreatedAt = DateTime.UtcNow,
            IsRunning = true
        };

        var cache = GetField<ConcurrentDictionary<string, SessionInfo>>(manager, "_sessionCache");
        cache[sessionId] = info;
        return info;
    }

    private static void AddDisconnectedClient(TtyHostSessionManager manager, string sessionId)
    {
        var clients = GetField<ConcurrentDictionary<string, TtyHostClient>>(manager, "_clients");
        clients[sessionId] = new TtyHostClient(sessionId, hostPid: 999999);
    }

    private static void InvokeHandleClientOutput(TtyHostSessionManager manager, string sessionId, byte[] output)
    {
        var method = typeof(TtyHostSessionManager).GetMethod(
            "HandleClientOutput",
            BindingFlags.Instance | BindingFlags.NonPublic)!;

        method.Invoke(manager, [sessionId, 120, 30, new ReadOnlyMemory<byte>(output)]);
    }

    private static void InvokeMergeCachedFields(SessionInfo refreshed, SessionInfo existing)
    {
        var method = typeof(TtyHostSessionManager).GetMethod(
            "MergeCachedFields",
            BindingFlags.Static | BindingFlags.NonPublic)!;

        method.Invoke(null, [refreshed, existing]);
    }

    private static T GetField<T>(TtyHostSessionManager manager, string name)
    {
        var field = typeof(TtyHostSessionManager).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
        return (T)field.GetValue(manager)!;
    }
}
