using Ai.Tlbx.MidTerm.Startup;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class ServerSetupTests
{
    [Fact]
    public void IsSourceDevLaunchMode_ReturnsTrueOnlyForSourceDev()
    {
        var previous = Environment.GetEnvironmentVariable("MIDTERM_LAUNCH_MODE");
        try
        {
            Environment.SetEnvironmentVariable("MIDTERM_LAUNCH_MODE", "source-dev");
            Assert.True(ServerSetup.IsSourceDevLaunchMode());

            Environment.SetEnvironmentVariable("MIDTERM_LAUNCH_MODE", "service");
            Assert.False(ServerSetup.IsSourceDevLaunchMode());
        }
        finally
        {
            Environment.SetEnvironmentVariable("MIDTERM_LAUNCH_MODE", previous);
        }
    }

    [Fact]
    public void BuildContentSecurityPolicy_WithoutPreviewOrigin_UsesDefaultFrameSources()
    {
        var csp = ServerSetup.BuildContentSecurityPolicy();

        Assert.Contains("frame-src 'self' blob: data:;", csp, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildContentSecurityPolicy_WithPreviewOrigin_AllowsDedicatedPreviewFrame()
    {
        var csp = ServerSetup.BuildContentSecurityPolicy("https://midterm.test:2001");

        Assert.Contains("frame-src 'self' blob: data: https://midterm.test:2001;", csp, StringComparison.Ordinal);
    }
}
