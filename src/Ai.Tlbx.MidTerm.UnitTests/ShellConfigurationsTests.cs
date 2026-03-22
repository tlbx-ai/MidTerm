using Ai.Tlbx.MidTerm.Common.Shells;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ShellConfigurationsTests
{
    [Fact]
    public void GetEnvironmentVariables_StripsDotnetWatchPoisoningFromInheritedShellEnvironment()
    {
        using var startupHooks = new EnvironmentVariableScope("DOTNET_STARTUP_HOOKS", @"Q:\fake\dotnet-watch-startup-hook.dll");
        using var watchFlag = new EnvironmentVariableScope("DOTNET_WATCH", "1");
        using var watchIteration = new EnvironmentVariableScope("DOTNET_WATCH_ITERATION", "7");
        using var modifiableAssemblies = new EnvironmentVariableScope("DOTNET_MODIFIABLE_ASSEMBLIES", "debug");
        using var hostingStartupAssemblies = new EnvironmentVariableScope("ASPNETCORE_HOSTINGSTARTUPASSEMBLIES", "Microsoft.AspNetCore.Watch.BrowserRefresh");

        var env = new PwshShellConfiguration().GetEnvironmentVariables();

        Assert.DoesNotContain("DOTNET_STARTUP_HOOKS", env.Keys, StringComparer.OrdinalIgnoreCase);
        Assert.DoesNotContain("DOTNET_WATCH", env.Keys, StringComparer.OrdinalIgnoreCase);
        Assert.DoesNotContain("DOTNET_WATCH_ITERATION", env.Keys, StringComparer.OrdinalIgnoreCase);
        Assert.DoesNotContain("DOTNET_MODIFIABLE_ASSEMBLIES", env.Keys, StringComparer.OrdinalIgnoreCase);
        Assert.DoesNotContain("ASPNETCORE_HOSTINGSTARTUPASSEMBLIES", env.Keys, StringComparer.OrdinalIgnoreCase);
    }

    private sealed class EnvironmentVariableScope : IDisposable
    {
        private readonly string _name;
        private readonly string? _originalValue;

        public EnvironmentVariableScope(string name, string? value)
        {
            _name = name;
            _originalValue = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public void Dispose()
        {
            Environment.SetEnvironmentVariable(_name, _originalValue);
        }
    }
}
