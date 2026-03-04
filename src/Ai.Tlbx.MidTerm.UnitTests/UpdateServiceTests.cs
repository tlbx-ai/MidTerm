using System.Text.Json;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Updates;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class UpdateServiceTests : IDisposable
{
    private readonly string _tempDir;

    public UpdateServiceTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), $"midterm_update_tests_{Guid.NewGuid():N}");
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

    public static IEnumerable<object[]> CompareVersionCases()
    {
        yield return ["1.0.0", "1.0.0", 0];
        yield return ["1.0", "1.0.0", 0];
        yield return ["1.2.0", "1.1.9", 1];
        yield return ["2.0.0", "10.0.0", -1];
        yield return ["1.0.0+abc", "1.0.0+def", 0];
        yield return ["1.0.1+abc", "1.0.0+def", 1];
        yield return ["1.0.0", "1.0.0-dev.1", 1];
        yield return ["1.0.0-dev.1", "1.0.0", -1];
        yield return ["1.0.0-dev.10", "1.0.0-dev.2", 1];
        yield return ["1.0.0-dev.2", "1.0.0-dev.10", -1];
        yield return ["1.0.0-DEV.2", "1.0.0-dev.2", 0];
        yield return ["1.0.0-alpha", "1.0.0-beta", -1];
        yield return ["1.0.x", "1.0.0", 0];
        yield return ["1.0.0.1", "1.0.0", 1];
    }

    [Theory]
    [MemberData(nameof(CompareVersionCases))]
    public void CompareVersions_HandlesSemVerAndPrereleaseOrdering(string left, string right, int expectedSign)
    {
        var actual = Math.Sign(UpdateService.CompareVersions(left, right));
        Assert.Equal(expectedSign, actual);
    }

    [Fact]
    public void ReadUpdateResult_FileMissing_ReturnsNull()
    {
        var result = UpdateService.ReadUpdateResult(_tempDir);
        Assert.Null(result);
    }

    [Fact]
    public void ReadUpdateResult_ValidFile_ReturnsParsedWithFoundTrue()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        var payload = new UpdateResult
        {
            Success = true,
            Message = "done",
            Details = "ok",
            Timestamp = "2026-02-28T00:00:00Z",
            LogFile = "update.log"
        };
        File.WriteAllText(path, JsonSerializer.Serialize(payload, AppJsonContext.Default.UpdateResult));

        var result = UpdateService.ReadUpdateResult(_tempDir);

        Assert.NotNull(result);
        Assert.True(result!.Found);
        Assert.True(result.Success);
        Assert.Equal("done", result.Message);
        Assert.Equal("ok", result.Details);
    }

    [Fact]
    public void ReadUpdateResult_ClearTrue_DeletesResultFile()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        File.WriteAllText(path, "{\"success\":true,\"message\":\"x\"}");

        var result = UpdateService.ReadUpdateResult(_tempDir, clear: true);

        Assert.NotNull(result);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public void ReadUpdateResult_InvalidJson_ReturnsNull()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        File.WriteAllText(path, "{ definitely not json");

        var result = UpdateService.ReadUpdateResult(_tempDir);

        Assert.Null(result);
        Assert.True(File.Exists(path));
    }

    [Fact]
    public void ClearUpdateResult_ExistingFile_DeletesIt()
    {
        var path = Path.Combine(_tempDir, "update-result.json");
        File.WriteAllText(path, "{\"success\":true}");

        UpdateService.ClearUpdateResult(_tempDir);

        Assert.False(File.Exists(path));
    }

    [Fact]
    public void ClearUpdateResult_MissingFile_DoesNotThrow()
    {
        var exception = Record.Exception(() => UpdateService.ClearUpdateResult(_tempDir));
        Assert.Null(exception);
    }
}
