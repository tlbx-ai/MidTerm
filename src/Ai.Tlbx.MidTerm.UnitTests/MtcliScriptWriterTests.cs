using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Services.Browser;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MtcliScriptWriterTests : IDisposable
{
    private readonly string _tempDir = Path.Combine(Path.GetTempPath(), "midterm-mtcli-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void WriteScripts_WritesApplyUpdateHelpers()
    {
        Directory.CreateDirectory(_tempDir);

        MtcliScriptWriter.WriteScripts(_tempDir, 2000, "test-token");

        var shell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.sh"));
        var powershell = File.ReadAllText(Path.Combine(_tempDir, "mtcli.ps1"));

        Assert.Contains("mt_apply_update()", shell, StringComparison.Ordinal);
        Assert.Contains("$_MT/api/update/apply", shell, StringComparison.Ordinal);
        Assert.Contains("Current version:", shell, StringComparison.Ordinal);

        Assert.Contains("function Mt-ApplyUpdate", powershell, StringComparison.Ordinal);
        Assert.Contains("$script:_MT/api/update/apply", powershell, StringComparison.Ordinal);
        Assert.Contains("Current version:", powershell, StringComparison.Ordinal);
    }

    [Fact]
    public void Ensure_WritesAgentsGuidanceWithApplyUpdateWorkflow()
    {
        Directory.CreateDirectory(_tempDir);

        MidtermDirectory.Ensure(_tempDir);

        var agentsPath = Path.Combine(_tempDir, MidtermDirectory.DirectoryName, "AGENTS.md");
        var agents = File.ReadAllText(agentsPath);

        Assert.Contains("guidance-version: 11", agents, StringComparison.Ordinal);
        Assert.Contains("mt_apply_update", agents, StringComparison.Ordinal);
        Assert.Contains("continue with the new build", agents, StringComparison.Ordinal);
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
}
