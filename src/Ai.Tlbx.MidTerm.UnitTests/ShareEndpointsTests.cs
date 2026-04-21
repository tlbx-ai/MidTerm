using Ai.Tlbx.MidTerm.Services.Share;
using Ai.Tlbx.MidTerm.Settings;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ShareEndpointsTests
{
    [Fact]
    public void BuildSharedSettings_BlanksSensitiveEnvironmentSettings()
    {
        var settings = new MidTermSettings
        {
            DefaultWorkingDirectory = @"C:\work",
            TerminalEnvironmentVariables = "FOO=bar",
            CodexEnvironmentVariables = "CODEX=1",
            ClaudeEnvironmentVariables = "CLAUDE=1",
            RunAsUser = "svc-midterm",
            RunAsUserSid = "S-1-5-18"
        };

        var shared = ShareEndpoints.BuildSharedSettings(settings);

        Assert.Equal(string.Empty, shared.DefaultWorkingDirectory);
        Assert.Equal(string.Empty, shared.TerminalEnvironmentVariables);
        Assert.Equal(string.Empty, shared.CodexEnvironmentVariables);
        Assert.Equal(string.Empty, shared.ClaudeEnvironmentVariables);
        Assert.Null(shared.RunAsUser);
        Assert.Null(shared.RunAsUserSid);
    }
}
