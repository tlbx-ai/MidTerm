using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;
using Xunit;
using SkiaSharp;

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
        await using var stream = new MemoryStream(BackgroundImageEncoderTests.CreatePng(16, 8));
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
        await using var stream = new MemoryStream(BackgroundImageEncoderTests.CreatePng(16, 8));
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

    [Fact]
    public async Task SaveAsync_NormalizesToWebpAndInvalidReplacementPreservesImage()
    {
        var settingsService = new SettingsService(_tempDir);
        var service = new BackgroundImageService(settingsService);
        using var input = new MemoryStream(BackgroundImageEncoderTests.CreatePng(4096, 1024));
        var result = await service.SaveAsync(new FormFile(input, 0, input.Length, "file", "large.png")
        {
            Headers = new HeaderDictionary(), ContentType = "image/png"
        });
        Assert.Equal("app-background-v2.webp", result.FileName);
        var path = service.GetCurrentImagePath(settingsService.Load())!;
        var saved = await File.ReadAllBytesAsync(path);
        using var decoded = SKBitmap.Decode(saved);
        Assert.Equal(2048, decoded.Width);
        Assert.Equal(512, decoded.Height);
        using var invalid = new MemoryStream(new byte[] { 1, 2, 3 });
        await Assert.ThrowsAsync<ArgumentException>(() => service.SaveAsync(
            new FormFile(invalid, 0, invalid.Length, "file", "broken.png")
            {
                Headers = new HeaderDictionary(), ContentType = "image/png"
            }));
        Assert.Equal(saved, await File.ReadAllBytesAsync(path));
        Assert.Equal(result.Revision, settingsService.Load().BackgroundImageRevision);
        Assert.Single(Directory.GetFiles(service.GetDirectory()));
    }

    [Theory]
    [InlineData("app-background.png")]
    [InlineData("app-background.jpg")]
    [InlineData("app-background-v1.jpg")]
    public async Task GetNormalizedImagePathAsync_MigratesOldImageOnceAndPreservesPreferences(string fileName)
    {
        var settingsService = new SettingsService(_tempDir);
        var service = new BackgroundImageService(settingsService);
        settingsService.Save(new MidTermSettings
        {
            BackgroundImageFileName = fileName,
            BackgroundImageRevision = 123,
            BackgroundImageEnabled = false,
            UiTransparency = 10,
            TerminalTransparency = 35
        });
        Directory.CreateDirectory(service.GetDirectory());
        var oldPath = Path.Combine(service.GetDirectory(), fileName);
        var pixels = BackgroundImageEncoderTests.CreatePng(4096, 32);
        if (fileName.EndsWith(".jpg", StringComparison.Ordinal))
        {
            pixels = BackgroundImageEncoderTests.CreateImage(4096, 32, SKEncodedImageFormat.Jpeg);
        }
        await File.WriteAllBytesAsync(oldPath, pixels);

        var paths = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => service.GetNormalizedImagePathAsync()));
        var path = Assert.IsType<string>(paths[0]);
        Assert.All(paths, value => Assert.Equal(path, value));
        Assert.False(File.Exists(oldPath));
        Assert.Equal("app-background-v2.webp", Path.GetFileName(path));
        var bytes = await File.ReadAllBytesAsync(path);
        using var decoded = SKBitmap.Decode(bytes);
        Assert.Equal(2048, decoded.Width);
        Assert.Equal(16, decoded.Height);
        var settings = settingsService.Load();
        Assert.False(settings.BackgroundImageEnabled);
        Assert.Equal(10, settings.UiTransparency);
        Assert.Equal(35, settings.TerminalTransparency);
        Assert.True(settings.BackgroundImageRevision > 123);

        // A fresh service represents a restart. Neither bytes nor revision may change.
        var restartedService = new BackgroundImageService(settingsService);
        Assert.Equal(path, await restartedService.GetNormalizedImagePathAsync());
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
        Assert.Equal(settings.BackgroundImageRevision, settingsService.Load().BackgroundImageRevision);
    }

    [Fact]
    public async Task GetNormalizedImagePathAsync_BrokenLegacyImageIsRetainedButNotServed()
    {
        var settingsService = new SettingsService(_tempDir);
        settingsService.Save(new MidTermSettings
        {
            BackgroundImageFileName = "app-background.png", BackgroundImageRevision = 123
        });
        var service = new BackgroundImageService(settingsService);
        Directory.CreateDirectory(service.GetDirectory());
        var path = Path.Combine(service.GetDirectory(), "app-background.png");
        byte[] original = [1, 2, 3];
        await File.WriteAllBytesAsync(path, original);
        Assert.Null(await service.GetNormalizedImagePathAsync());
        Assert.Null(await service.GetNormalizedImagePathAsync());
        Assert.Equal(original, await File.ReadAllBytesAsync(path));
        Assert.Equal(123, settingsService.Load().BackgroundImageRevision);
        Assert.Single(Directory.GetFiles(service.GetDirectory()));
    }
}
