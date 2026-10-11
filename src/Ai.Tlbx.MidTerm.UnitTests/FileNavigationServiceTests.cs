using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class FileNavigationServiceTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), $"file_navigation_test_{Guid.NewGuid():N}");
    private readonly SessionPathAllowlistService _permissions = new();
    public FileNavigationServiceTests() => Directory.CreateDirectory(Path.Combine(_folder, "child", "nested"));
    private bool Accessible(string path) => _permissions.IsPathAllowed("owner", path, _folder);

    [Fact]
    public void ParentIsHierarchyRatherThanThePreviousVisit()
    {
        var child = Path.Combine(_folder, "child", "nested");
        var result = FileNavigationService.Describe(child, Accessible);
        Assert.Equal(Path.Combine(_folder, "child"), result.ParentPath);
        Assert.True(result.IsDirectory);
        Assert.Equal([_folder, Path.Combine(_folder, "child"), child], result.Breadcrumbs.Select(location => location.Path).ToArray());
        Assert.Null(FileNavigationService.Describe(_folder, Accessible).ParentPath);
    }

    [Fact]
    public void FileParentAndDeletedTargetHaveAUsableReturnDirectory()
    {
        var path = Path.Combine(_folder, "child", "notes.txt");
        File.WriteAllText(path, "notes");
        Assert.Equal(Path.GetDirectoryName(path), FileNavigationService.Describe(path, Accessible).ParentPath);
        File.Delete(path);
        var missing = FileNavigationService.Describe(path, Accessible);
        Assert.False(missing.Exists);
        Assert.Equal(Path.GetDirectoryName(path), missing.ParentPath);
    }

    [Fact]
    public void ExactFilePermissionDoesNotGrantItsParent()
    {
        var path = Path.Combine(_folder, "child", "notes.txt");
        File.WriteAllText(path, "notes");
        _permissions.RegisterPath("isolated", path);
        var result = FileNavigationService.Describe(path, candidate => _permissions.IsPathAllowed("isolated", candidate, null));
        Assert.Null(result.ParentPath);
        Assert.True(result.Exists);
        Assert.Empty(result.Breadcrumbs);
        Assert.NotNull(result.File);
        Assert.Equal(path, result.File.FullPath);
        Assert.Equal("notes.txt", result.File.Name);
    }

    [Fact]
    public void UnrelatedPathAndSimilarPrefixAreRejected()
    {
        Assert.Throws<UnauthorizedAccessException>(() => FileNavigationService.Describe(Path.GetTempPath(), Accessible));
        Assert.Throws<UnauthorizedAccessException>(() => FileNavigationService.Describe(_folder + "-other", Accessible));
    }

    public void Dispose()
    {
        var absolute = Path.GetFullPath(_folder);
        if (!absolute.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(absolute).StartsWith("file_navigation_test_", StringComparison.Ordinal))
            throw new InvalidOperationException("Unexpected navigation test fixture.");
        Directory.Delete(absolute, recursive: true);
        GC.SuppressFinalize(this);
    }
}
