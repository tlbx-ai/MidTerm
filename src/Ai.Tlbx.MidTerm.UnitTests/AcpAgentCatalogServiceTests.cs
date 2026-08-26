using System.Text.Json;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class AcpAgentCatalogServiceTests
{
    [Fact]
    public void GetDefinitions_IncludesSupportedRegistryAgents()
    {
        var settingsDirectory = CreateTempDirectory();
        try
        {
            var catalog = new AcpAgentCatalogService(new SettingsService(settingsDirectory));

            var definitions = catalog.GetDefinitions();

            Assert.Equal(["agent", "stdio"], definitions.Single(definition => definition.Profile == "grok").Arguments);
            Assert.Equal(["acp"], definitions.Single(definition => definition.Profile == "opencode").Arguments);
            Assert.Equal(["--acp"], definitions.Single(definition => definition.Profile == "gemini").Arguments);
            Assert.Equal(["--acp"], definitions.Single(definition => definition.Profile == "copilot").Arguments);
        }
        finally
        {
            Directory.Delete(settingsDirectory, recursive: true);
        }
    }

    [Fact]
    public void TryResolve_LoadsCustomAgentWithoutCodeChanges()
    {
        var settingsDirectory = CreateTempDirectory();
        var executablePath = Path.Combine(settingsDirectory, OperatingSystem.IsWindows() ? "my-agent.exe" : "my-agent");
        File.WriteAllText(executablePath, string.Empty);
        try
        {
            File.WriteAllText(
                Path.Combine(settingsDirectory, AcpAgentCatalogService.ManifestFileName),
                JsonSerializer.Serialize(new
                {
                    agents = new[]
                    {
                        new
                        {
                            profile = "my-agent",
                            name = "My ACP Agent",
                            command = executablePath,
                            arguments = new[] { "serve", "--acp" }
                        }
                    }
                }));
            var catalog = new AcpAgentCatalogService(new SettingsService(settingsDirectory));

            var resolved = catalog.TryResolve("MY-AGENT", null, out var definition);

            Assert.True(resolved);
            Assert.Equal("my-agent", definition.Profile);
            Assert.Equal("My ACP Agent", definition.Name);
            Assert.Equal(executablePath, definition.ExecutablePath);
            Assert.Equal(["serve", "--acp"], definition.Arguments);
        }
        finally
        {
            Directory.Delete(settingsDirectory, recursive: true);
        }
    }

    private static string CreateTempDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "tlbx-acp-catalog-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }
}
