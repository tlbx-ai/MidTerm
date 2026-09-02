using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[Collection(PathSensitiveEnvironmentCollection.Name)]
public sealed class AgentControllerInstallationServiceTests
{
    [Fact]
    public void GetInstalled_ListsClaudeAgentSdkWhenClaudeAndNodeAreAvailable()
    {
        using var fakeClaude = FakeClaudePathScope.Create();
        var settingsDirectory = Path.Combine(fakeClaude.Root, "settings");
        Directory.CreateDirectory(settingsDirectory);
        var settings = new SettingsService(settingsDirectory);
        var service = new AgentControllerInstallationService(settings, new AcpAgentCatalogService(settings));

        var installation = Assert.Single(service.GetInstalled(), item => item.Profile == AiCliProfileService.ClaudeProfile);

        Assert.Equal("Claude Agent SDK", installation.Protocol);
        Assert.True(installation.SupportsResume);
    }
}
