using Ai.Tlbx.MidTerm.Services.Security;
using Ai.Tlbx.MidTerm.Services.Hosting;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class WindowsFirewallServiceTests
{
    [Fact]
    public void GetStatus_ReturnsMissingRule_WhenNoManagedRuleExists()
    {
        if (!OperatingSystem.IsWindows()) return;

        var service = CreateService("""{"exists":false}""");

        var status = service.GetStatus();

        Assert.True(status.Supported);
        Assert.False(status.RulePresent);
        Assert.Equal(2000, status.Port);
        Assert.Equal("0.0.0.0", status.BindAddress);
    }

    [Fact]
    public void GetStatus_ReturnsActiveRule_WhenManagedRuleMatchesCurrentProcess()
    {
        if (!OperatingSystem.IsWindows()) return;

        var processPath = Environment.ProcessPath ?? "mt.exe";
        var service = CreateService($$"""{"exists":true,"enabled":"True","localPort":"2000","program":"{{EscapeJson(processPath)}}" }""");

        var status = service.GetStatus();

        Assert.True(status.RulePresent);
        Assert.True(status.RuleEnabled);
        Assert.True(status.MatchesCurrentPort);
        Assert.True(status.MatchesCurrentProgram);
        Assert.Equal("MidTerm HTTPS", status.RuleName);
    }

    [Fact]
    public void GetStatus_DetectsOutOfDateRule_WhenPortDoesNotMatch()
    {
        if (!OperatingSystem.IsWindows()) return;

        var processPath = Environment.ProcessPath ?? "mt.exe";
        var service = CreateService($$"""{"exists":true,"enabled":"True","localPort":"3000","program":"{{EscapeJson(processPath)}}" }""");

        var status = service.GetStatus();

        Assert.True(status.RulePresent);
        Assert.False(status.MatchesCurrentPort);
        Assert.True(status.MatchesCurrentProgram);
        Assert.Equal("3000", status.RuleLocalPort);
    }

    private static WindowsFirewallService CreateService(string json)
    {
        return new WindowsFirewallService(
            new ServerBindingInfo(2000, "0.0.0.0"),
            new FakePowerShellCommandRunner(json));
    }

    private static string EscapeJson(string value)
    {
        return value.Replace("\\", "\\\\", StringComparison.Ordinal);
    }

    private sealed class FakePowerShellCommandRunner : IPowerShellCommandRunner
    {
        private readonly string _json;

        public FakePowerShellCommandRunner(string json)
        {
            _json = json;
        }

        public PowerShellCommandResult Run(string script)
        {
            return new PowerShellCommandResult
            {
                ExitCode = 0,
                StdOut = _json
            };
        }
    }
}
