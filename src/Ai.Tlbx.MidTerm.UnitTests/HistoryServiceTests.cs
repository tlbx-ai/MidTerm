using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.History;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class HistoryServiceTests : IDisposable
{
    private readonly string _tempDir;

    public HistoryServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_history_tests_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_tempDir);
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

    [Fact]
    public void GetEntries_LegacyHistoryWithoutLaunchMode_DefaultsToTerminal()
    {
        if (!OperatingSystem.IsWindows()) return;

        var payload = """
        {
          "entries": [
            {
              "id": "legacy-1",
              "shellType": "Pwsh",
              "executable": "pwsh",
              "commandLine": null,
              "workingDirectory": "Q:\\repo",
              "isStarred": true,
              "label": "Legacy",
              "lastUsed": "2026-03-25T00:00:00Z",
              "order": 0
            }
          ]
        }
        """;
        File.WriteAllText(Path.Combine(_tempDir, "history.json"), payload);

        using var service = new HistoryService(new SettingsService(_tempDir));

        var entry = Assert.Single(service.GetEntries());
        Assert.Equal(LaunchEntryLaunchModes.Terminal, entry.LaunchMode);
        Assert.Null(entry.Profile);
    }

    [Fact]
    public void RecordEntry_PersistsAppServerControlModeAndProfile()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var service = new HistoryService(new SettingsService(_tempDir));

        var id = service.RecordEntry(
            "Pwsh",
            "codex",
            null,
            @"Q:\repo",
            launchMode: LaunchEntryLaunchModes.AppServerControl,
            profile: "codex");

        Assert.NotNull(id);

        var entry = service.GetEntry(id!);
        Assert.NotNull(entry);
        Assert.Equal(LaunchEntryLaunchModes.AppServerControl, entry!.LaunchMode);
        Assert.Equal("codex", entry.Profile);
        Assert.Equal(HistorySurfaceTypes.Codex, entry.SurfaceType);
    }

    [Fact]
    public void RecordEntry_PersistsTerminalSurfaceAndForegroundProcess()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var service = new HistoryService(new SettingsService(_tempDir));

        var id = service.RecordEntry(
            "Pwsh",
            "dotnet",
            "dotnet test",
            @"Q:\repo",
            surfaceType: HistorySurfaceTypes.Terminal,
            foregroundProcessName: "dotnet",
            foregroundProcessCommandLine: "dotnet test",
            foregroundProcessDisplayName: "dotnet test",
            foregroundProcessIdentity: "dotnet");

        Assert.NotNull(id);

        var entry = service.GetEntry(id!);
        Assert.NotNull(entry);
        Assert.Equal(HistorySurfaceTypes.Terminal, entry!.SurfaceType);
        Assert.Equal("dotnet", entry.ForegroundProcessName);
        Assert.Equal("dotnet test", entry.ForegroundProcessCommandLine);
        Assert.Equal("dotnet test", entry.ForegroundProcessDisplayName);
        Assert.Equal("dotnet", entry.ForegroundProcessIdentity);
    }

    [Fact]
    public void RecordEntry_NormalizesAndPersistsLaunchOrigin()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var service = new HistoryService(new SettingsService(_tempDir));

        var id = service.RecordEntry(
            "Pwsh",
            "codex",
            null,
            @"Q:\repo",
            launchMode: LaunchEntryLaunchModes.AppServerControl,
            profile: "codex",
            launchOrigin: "Ad-Hoc",
            surfaceType: HistorySurfaceTypes.Codex);

        Assert.NotNull(id);

        var entry = service.GetEntry(id!);
        Assert.NotNull(entry);
        Assert.Equal(SessionLaunchOrigins.AdHoc, entry!.LaunchOrigin);
        Assert.Equal(HistorySurfaceTypes.Codex, entry.SurfaceType);
    }

    [Fact]
    public void RecordEntry_PersistsNotes()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var service = new HistoryService(new SettingsService(_tempDir));

        var id = service.RecordEntry(
            "Pwsh",
            "codex",
            null,
            @"Q:\repo",
            notes: "size ownership\ncheck followers");

        Assert.NotNull(id);

        var entry = service.GetEntry(id!);
        Assert.NotNull(entry);
        Assert.Equal("size ownership\ncheck followers", entry!.Notes);
    }

    [Fact]
    public void SetNotes_NormalizesToFiveLines()
    {
        if (!OperatingSystem.IsWindows()) return;

        using var service = new HistoryService(new SettingsService(_tempDir));
        var id = service.RecordEntry("Pwsh", "codex", null, @"Q:\repo");
        Assert.NotNull(id);

        var ok = service.SetNotes(id!, "one\ntwo\nthree\nfour\nfive\nsix");

        Assert.True(ok);
        Assert.Equal("one\ntwo\nthree\nfour\nfive", service.GetEntry(id!)!.Notes);
    }
}
