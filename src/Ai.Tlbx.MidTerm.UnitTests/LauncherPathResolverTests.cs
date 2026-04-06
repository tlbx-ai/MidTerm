using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class LauncherPathResolverTests : IDisposable
{
    private readonly string _tempDir;
    private readonly string _configuredStartDir;

    public LauncherPathResolverTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm-launcher-tests-{Guid.NewGuid():N}");
        _configuredStartDir = Path.Combine(_tempDir, "configured");
        Directory.CreateDirectory(_configuredStartDir);
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
    public void TryResolveConfiguredStartPath_ReturnsExistingAbsoluteDirectory()
    {
        var resolved = LauncherPathResolver.TryResolveConfiguredStartPath(_configuredStartDir, _tempDir);

        Assert.Equal(Path.GetFullPath(_configuredStartDir), resolved);
    }

    [Fact]
    public void TryResolveConfiguredStartPath_ExpandsEnvironmentVariables()
    {
        Environment.SetEnvironmentVariable("MIDTERM_TEST_START_PATH", _configuredStartDir);
        try
        {
            var resolved = LauncherPathResolver.TryResolveConfiguredStartPath(
                "%MIDTERM_TEST_START_PATH%",
                _tempDir);

            Assert.Equal(Path.GetFullPath(_configuredStartDir), resolved);
        }
        finally
        {
            Environment.SetEnvironmentVariable("MIDTERM_TEST_START_PATH", null);
        }
    }

    [Fact]
    public void TryResolveConfiguredStartPath_FallsBackForMissingOrRelativePaths()
    {
        Assert.Null(LauncherPathResolver.TryResolveConfiguredStartPath("missing", _tempDir));
        Assert.Null(LauncherPathResolver.TryResolveConfiguredStartPath("relative\\path", _tempDir));
    }
}
