using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class FileServiceTests : IDisposable
{
    private readonly string _tempDir;

    public FileServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_test_{Guid.NewGuid():N}");
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

        FileService.ResetFileInfoCacheForTests();

        GC.SuppressFinalize(this);
    }

    // =======================================================================
    // ValidatePath
    // =======================================================================

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public void ValidatePath_RejectsEmptyOrWhitespace(string path)
    {
        var result = FileService.ValidatePath(path, out var errorResult);

        Assert.False(result);
        Assert.NotNull(errorResult);
    }

    [Fact]
    public void ValidatePath_RejectsTraversal()
    {
        var result = FileService.ValidatePath(@"C:\foo\..\bar", out var errorResult);

        Assert.False(result);
        Assert.NotNull(errorResult);
    }

    [Fact]
    public void ValidatePath_RejectsRelativePath()
    {
        var result = FileService.ValidatePath("src/main.ts", out var errorResult);

        Assert.False(result);
        Assert.NotNull(errorResult);
    }

    // =======================================================================
    // IsWithinDirectory
    // =======================================================================

    [Fact]
    public void IsWithinDirectory_PrefixAttackBlocked()
    {
        var dir = Path.Combine(_tempDir, "Users");
        var attack = Path.Combine(_tempDir, "Users2", "file.txt");

        Assert.False(FileService.IsWithinDirectory(attack, dir));
    }

    // =======================================================================
    // GetSlashVariants
    // =======================================================================

    // =======================================================================
    // SearchTree
    // =======================================================================

    // =======================================================================
    // GetFileInfo
    // =======================================================================

    [Fact]
    public void GetFileInfo_UsesProcessGlobalCacheAcrossCalls()
    {
        FileService.ResetFileInfoCacheForTests();
        var filePath = Path.Combine(_tempDir, "cached.txt");
        File.WriteAllText(filePath, "cached");

        var initial = FileService.GetFileInfo(filePath);
        File.Delete(filePath);
        var cached = FileService.GetFileInfo(filePath);

        Assert.True(initial.Exists);
        Assert.True(cached.Exists);

        FileService.ResetFileInfoCacheForTests();

        var refreshed = FileService.GetFileInfo(filePath);
        Assert.False(refreshed.Exists);
    }

    [Fact]
    public void FreshMetadataReflectsChangesWithoutWaitingForCacheExpiry()
    {
        var path = Path.Combine(_tempDir, "fresh.txt");
        File.WriteAllText(path, "a");
        Assert.Equal(1, FileService.GetFileInfo(path).Size);
        File.WriteAllText(path, "abcdef");
        Assert.Equal(6, FileService.GetFileInfo(path, fresh: true).Size);
        Assert.Equal(6, FileService.GetFileInfo(path).Size);
        File.Delete(path);
        Assert.False(FileService.GetFileInfo(path, fresh: true).Exists);
    }

    [Fact]
    public void CacheKeysFollowPlatformCaseSensitivity()
    {
        var upper = Path.Combine(_tempDir, "Case.txt"); var lower = Path.Combine(_tempDir, "case.txt");
        File.WriteAllText(upper, "upper");
        _ = FileService.GetFileInfo(upper);
        if (!OperatingSystem.IsWindows()) { File.WriteAllText(lower, "x"); Assert.Equal(1, FileService.GetFileInfo(lower).Size); }
        else Assert.Equal(5, FileService.GetFileInfo(lower).Size);
    }
}
