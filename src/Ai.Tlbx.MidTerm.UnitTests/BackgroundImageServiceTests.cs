using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class BackgroundImageServiceTests : IDisposable
{
    private readonly string _tempDir;

    public BackgroundImageServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_background_tests_{Guid.NewGuid():N}");
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
    public void GetDirectory_UsesSettingsDirectoryBackgroundFolder()
    {
        var settingsService = new SettingsService(_tempDir);
        var service = new BackgroundImageService(settingsService);

        var directory = service.GetDirectory();

        Assert.Equal(Path.Combine(_tempDir, "backgrounds"), directory);
        Assert.Equal(directory, LogPaths.GetBackgroundDirectory(_tempDir));
    }

    [Fact]
    public void GetCurrentImagePath_FallsBackToLegacyDirectory()
    {
        var settingsService = new SettingsService(_tempDir);
        var service = new BackgroundImageService(settingsService);
        var settings = new MidTermSettings
        {
            BackgroundImageFileName = "app-background.png"
        };

        var legacyDirectory = service.GetLegacyDirectory();
        Directory.CreateDirectory(legacyDirectory);
        var legacyPath = Path.Combine(legacyDirectory, settings.BackgroundImageFileName);
        File.WriteAllBytes(legacyPath, [1, 2, 3]);

        var resolvedPath = service.GetCurrentImagePath(settings);

        Assert.Equal(legacyPath, resolvedPath);
    }

    [Fact]
    public void GetCurrentImagePath_PrefersNewDirectoryOverLegacyDirectory()
    {
        var settingsService = new SettingsService(_tempDir);
        var service = new BackgroundImageService(settingsService);
        var settings = new MidTermSettings
        {
            BackgroundImageFileName = "app-background.png"
        };

        var currentDirectory = service.GetDirectory();
        Directory.CreateDirectory(currentDirectory);
        var currentPath = Path.Combine(currentDirectory, settings.BackgroundImageFileName);
        File.WriteAllBytes(currentPath, [1, 2, 3]);

        var legacyDirectory = service.GetLegacyDirectory();
        Directory.CreateDirectory(legacyDirectory);
        File.WriteAllBytes(Path.Combine(legacyDirectory, settings.BackgroundImageFileName), [4, 5, 6]);

        var resolvedPath = service.GetCurrentImagePath(settings);

        Assert.Equal(currentPath, resolvedPath);
    }

    [Fact]
    public async Task SaveAsync_RaisesUiAndTerminalTransparencyToRevealUploadedImage()
    {
        var settingsService = new SettingsService(_tempDir);
        settingsService.Save(new MidTermSettings
        {
            UiTransparency = 20,
            TerminalTransparency = 40,
            TerminalCellBackgroundTransparency = 10
        });
        var service = new BackgroundImageService(settingsService);
        await using var stream = new MemoryStream([1, 2, 3]);
        var file = new FormFile(stream, 0, stream.Length, "file", "wallpaper.png")
        {
            Headers = new HeaderDictionary(),
            ContentType = "image/png"
        };

        await service.SaveAsync(file);

        var settings = settingsService.Load();
        Assert.Equal(50, settings.UiTransparency);
        Assert.Equal(50, settings.TerminalTransparency);
        Assert.Equal(10, settings.TerminalCellBackgroundTransparency);
    }

    [Fact]
    public async Task SaveAsync_PreservesExistingTransparencyAboveUploadMinimum()
    {
        var settingsService = new SettingsService(_tempDir);
        settingsService.Save(new MidTermSettings
        {
            UiTransparency = 60,
            TerminalTransparency = 70
        });
        var service = new BackgroundImageService(settingsService);
        await using var stream = new MemoryStream([1, 2, 3]);
        var file = new FormFile(stream, 0, stream.Length, "file", "wallpaper.jpg")
        {
            Headers = new HeaderDictionary(),
            ContentType = "image/jpeg"
        };

        await service.SaveAsync(file);

        var settings = settingsService.Load();
        Assert.Equal(60, settings.UiTransparency);
        Assert.Equal(70, settings.TerminalTransparency);
    }
}
