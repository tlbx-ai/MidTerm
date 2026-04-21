using System.Text;
using Ai.Tlbx.MidTerm.Startup;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class EndpointSetupTests
{
    [Fact]
    public void BuildWindowsServiceRestartScript_WaitsForStopAndStartsService()
    {
        var script = EndpointSetup.BuildWindowsServiceRestartScript("MidTerm");

        Assert.Contains("$serviceName = 'MidTerm'", script, StringComparison.Ordinal);
        Assert.Contains("Get-Service -Name $serviceName -ErrorAction SilentlyContinue", script, StringComparison.Ordinal);
        Assert.Contains("[System.ServiceProcess.ServiceControllerStatus]::Stopped", script, StringComparison.Ordinal);
        Assert.Contains("Start-Service -Name $serviceName -ErrorAction Stop", script, StringComparison.Ordinal);
    }

    [Fact]
    public void EncodePowerShellScript_UsesUtf16Base64()
    {
        const string script = "Write-Host 'restart'";

        var encoded = EndpointSetup.EncodePowerShellScript(script);
        var decoded = Encoding.Unicode.GetString(Convert.FromBase64String(encoded));

        Assert.Equal(script, decoded);
    }

    [Fact]
    public void BuildWindowsServiceRestartScript_EscapesSingleQuotesInServiceName()
    {
        var script = EndpointSetup.BuildWindowsServiceRestartScript("Mid'Term");

        Assert.Contains("$serviceName = 'Mid''Term'", script, StringComparison.Ordinal);
    }
}
