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

        Assert.Contains("script-src 'self' 'wasm-unsafe-eval';", csp, StringComparison.Ordinal);
        Assert.Contains("frame-src 'self' blob: data:;", csp, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildContentSecurityPolicy_WithPreviewOrigin_AllowsDedicatedPreviewFrame()
    {
        var csp = ServerSetup.BuildContentSecurityPolicy("https://midterm.test:2001");

        Assert.Contains("frame-src 'self' blob: data: https://midterm.test:2001;", csp, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildContentSecurityPolicy_WithDevAssetOrigin_AllowsOnlyAssetResourceTypes()
    {
        var csp = ServerSetup.BuildContentSecurityPolicy(
            previewOrigin: null,
            devAssetOrigin: "https://127.0.0.1:2100");

        Assert.Contains("script-src 'self' 'wasm-unsafe-eval' https://127.0.0.1:2100;", csp, StringComparison.Ordinal);
        Assert.Contains("style-src 'self' 'unsafe-inline' https://127.0.0.1:2100;", csp, StringComparison.Ordinal);
        Assert.Contains("font-src 'self' data: https://127.0.0.1:2100;", csp, StringComparison.Ordinal);
        Assert.Contains("connect-src 'self' ws: wss:", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("connect-src 'self' https://127.0.0.1:2100", csp, StringComparison.Ordinal);
    }
}
