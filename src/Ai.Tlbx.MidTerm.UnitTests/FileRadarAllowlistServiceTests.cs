using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class FileRadarAllowlistServiceTests
{
    private readonly FileRadarAllowlistService _service = new();

    [Fact]
    public void RegisterPath_ThenIsPathAllowed_ReturnsTrue()
    {
        _service.RegisterPath("s1", @"C:\Users\test\file.txt");

        Assert.True(_service.IsPathAllowed("s1", @"C:\Users\test\file.txt", null));
    }

    [Fact]
    public void UnregisteredPath_ReturnsFlase()
    {
        Assert.False(_service.IsPathAllowed("s1", @"C:\Users\test\unknown.txt", null));
    }

    [Fact]
    public void PathUnderWorkingDirectory_IsAllowed()
    {
        var workDir = Path.Combine(Path.GetTempPath(), "midterm_test_wd");
        var child = Path.Combine(workDir, "src", "file.cs");

        Assert.True(_service.IsPathAllowed("s1", child, workDir));
    }

    [Fact]
    public void PathEqualsWorkingDirectory_IsAllowed()
    {
        var workDir = Path.Combine(Path.GetTempPath(), "midterm_test_wd");

        Assert.True(_service.IsPathAllowed("s1", workDir, workDir));
    }

    [Fact]
    public void PathOutsideWorkingDir_AndNotRegistered_ReturnsFalse()
    {
        var workDir = Path.Combine(Path.GetTempPath(), "midterm_test_wd");
        var outside = Path.Combine(Path.GetTempPath(), "other_project", "file.cs");

        Assert.False(_service.IsPathAllowed("s1", outside, workDir));
    }

    [Fact]
    public void FifoEviction_OldestPathRemoved()
    {
        for (var i = 0; i < 1001; i++)
        {
            _service.RegisterPath("s1", Path.Combine(Path.GetTempPath(), $"file_{i:D4}.txt"));
        }

        // First path should have been evicted
        Assert.False(_service.IsPathAllowed("s1", Path.Combine(Path.GetTempPath(), "file_0000.txt"), null));
        // Last path should still be allowed
        Assert.True(_service.IsPathAllowed("s1", Path.Combine(Path.GetTempPath(), "file_1000.txt"), null));
    }

    [Fact]
    public void DuplicateRegistration_DoesNotCountTowardCapacity()
    {
        var path = Path.Combine(Path.GetTempPath(), "dupe.txt");
        _service.RegisterPath("s1", path);
        _service.RegisterPath("s1", path);

        Assert.True(_service.IsPathAllowed("s1", path, null));
    }

    [Fact]
    public void ParentDirectory_InAllowlist_AllowsChildPath()
    {
        var parent = Path.Combine(Path.GetTempPath(), "midterm_parent");
        _service.RegisterPath("s1", parent);

        var child = Path.Combine(parent, "sub", "file.txt");
        Assert.True(_service.IsPathAllowed("s1", child, null));
    }

    [Fact]
    public void ChildInAllowlist_DoesNotAllowParent()
    {
        var parent = Path.Combine(Path.GetTempPath(), "midterm_parent2");
        var child = Path.Combine(parent, "sub", "file.txt");
        _service.RegisterPath("s1", child);

        Assert.False(_service.IsPathAllowed("s1", parent, null));
    }

    [Fact]
    public void ClearSession_RemovesAllPaths()
    {
        _service.RegisterPath("s1", Path.Combine(Path.GetTempPath(), "a.txt"));
        _service.RegisterPath("s1", Path.Combine(Path.GetTempPath(), "b.txt"));
        _service.ClearSession("s1");

        Assert.False(_service.IsPathAllowed("s1", Path.Combine(Path.GetTempPath(), "a.txt"), null));
    }

    [Fact]
    public void CaseInsensitiveMatching()
    {
        _service.RegisterPath("s1", @"C:\Users\Test\File.txt");

        Assert.True(_service.IsPathAllowed("s1", @"C:\users\test\file.txt", null));
    }

    [Fact]
    public void TrailingSlash_Normalized()
    {
        _service.RegisterPath("s1", Path.Combine(Path.GetTempPath(), "folder") + Path.DirectorySeparatorChar);

        Assert.True(_service.IsPathAllowed("s1", Path.Combine(Path.GetTempPath(), "folder"), null));
    }

    [Fact]
    public void NullOrEmptyPath_ReturnsFalse()
    {
        Assert.False(_service.IsPathAllowed("s1", "", null));
        Assert.False(_service.IsPathAllowed("s1", " ", null));
    }

    [Fact]
    public void PrefixAttack_Blocked()
    {
        var dir = Path.Combine(Path.GetTempPath(), "midterm_lo");
        _service.RegisterPath("s1", dir);

        var attack = Path.Combine(Path.GetTempPath(), "midterm_log", "secret.txt");
        Assert.False(_service.IsPathAllowed("s1", attack, null));
    }

    [Fact]
    public void DifferentSessions_AreIsolated()
    {
        _service.RegisterPath("session_a", Path.Combine(Path.GetTempPath(), "a_file.txt"));

        Assert.False(_service.IsPathAllowed("session_b", Path.Combine(Path.GetTempPath(), "a_file.txt"), null));
    }
}
