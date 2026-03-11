using Ai.Tlbx.MidTerm.Startup;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class ServerSetupTests
{
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
