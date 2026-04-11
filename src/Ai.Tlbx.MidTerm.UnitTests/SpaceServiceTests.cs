using System.Collections.Concurrent;
using System.Reflection;
using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Services.Spaces;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SpaceServiceTests
{
    [Fact]
    public async Task ReconcileSessionBindingsAsync_RebindsSpaceLaunchByWorkspacePath()
    {
        var stateDir = CreateTempDirectory();
        var workspaceDir = CreateWorkspaceDirectory(stateDir, "repo-root");

        try
        {
            var settingsService = new SettingsService(stateDir);
            using var historyService = new HistoryService(settingsService);
            var spaceService = new SpaceService(settingsService, historyService);
            await using var manager = CreateManager(new SessionControlStateService(stateDir));

            var importedSpace = await spaceService.ImportAsync(workspaceDir, null, manager);
            Assert.NotNull(importedSpace);

            AddCachedSession(manager, "s1").CurrentDirectory = workspaceDir;
            Assert.True(manager.SetLaunchOrigin("s1", SessionLaunchOrigins.Space));
            Assert.True(manager.SetWorkspacePath("s1", workspaceDir));
            Assert.True(manager.SetSpaceId("s1", null));

            await spaceService.ReconcileSessionBindingsAsync(manager);

            var dto = manager.GetSessionList().Sessions.Single(s => s.Id == "s1");
            Assert.Equal(importedSpace!.Id, dto.SpaceId);
            Assert.Equal(SessionLaunchOrigins.Space, manager.GetLaunchOrigin("s1"));
            Assert.False(dto.IsAdHoc);
        }
        finally
        {
            Directory.Delete(stateDir, recursive: true);
        }
    }

    [Fact]
    public async Task ReconcileSessionBindingsAsync_DoesNotAdoptAdHocSessionByWorkspacePath()
    {
        var stateDir = CreateTempDirectory();
        var workspaceDir = CreateWorkspaceDirectory(stateDir, "repo-root");

        try
        {
            var settingsService = new SettingsService(stateDir);
            using var historyService = new HistoryService(settingsService);
            var spaceService = new SpaceService(settingsService, historyService);
            await using var manager = CreateManager(new SessionControlStateService(stateDir));

            var importedSpace = await spaceService.ImportAsync(workspaceDir, null, manager);
            Assert.NotNull(importedSpace);

            AddCachedSession(manager, "s1").CurrentDirectory = workspaceDir;
            Assert.True(manager.SetLaunchOrigin("s1", SessionLaunchOrigins.AdHoc));
            Assert.True(manager.SetWorkspacePath("s1", workspaceDir));
            Assert.True(manager.SetSpaceId("s1", null));

            await spaceService.ReconcileSessionBindingsAsync(manager);

            var dto = manager.GetSessionList().Sessions.Single(s => s.Id == "s1");
            Assert.Null(dto.SpaceId);
            Assert.True(dto.IsAdHoc);
        }
        finally
        {
            Directory.Delete(stateDir, recursive: true);
        }
    }

    [Fact]
    public async Task GetSpaceAsync_UsesRouteSafePrimaryWorkspaceKey()
    {
        var stateDir = CreateTempDirectory();
        var workspaceDir = CreateWorkspaceDirectory(stateDir, "repo-root");

        try
        {
            var settingsService = new SettingsService(stateDir);
            using var historyService = new HistoryService(settingsService);
            var spaceService = new SpaceService(settingsService, historyService);
            await using var manager = CreateManager(new SessionControlStateService(stateDir));

            var importedSpace = await spaceService.ImportAsync(workspaceDir, null, manager);
            Assert.NotNull(importedSpace);

            var space = await spaceService.GetSpaceAsync(importedSpace!.Id, manager);
            Assert.NotNull(space);
            Assert.False(string.IsNullOrWhiteSpace(space!.PrimaryWorkspaceKey));
            Assert.DoesNotContain("/", space.PrimaryWorkspaceKey!, StringComparison.Ordinal);
            Assert.DoesNotContain(":", space.PrimaryWorkspaceKey!, StringComparison.Ordinal);

            var resolved = await spaceService.ResolveWorkspacePathAsync(
                importedSpace.Id,
                space.PrimaryWorkspaceKey!);
            Assert.Equal(workspaceDir, resolved, ignoreCase: OperatingSystem.IsWindows());
        }
        finally
        {
            Directory.Delete(stateDir, recursive: true);
        }
    }

    private static TtyHostSessionManager CreateManager(SessionControlStateService? sessionControlStateService = null)
    {
        return new TtyHostSessionManager(
            expectedVersion: "1.0.0",
            minCompatibleVersion: "1.0.0",
            sessionControlStateService: sessionControlStateService);
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

    private static T GetField<T>(TtyHostSessionManager manager, string name)
    {
        var field = typeof(TtyHostSessionManager).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!;
        return (T)field.GetValue(manager)!;
    }

    private static string CreateTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "midterm-space-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string CreateWorkspaceDirectory(string root, string name)
    {
        var path = Path.Combine(root, name);
        Directory.CreateDirectory(path);
        return path;
    }
}
