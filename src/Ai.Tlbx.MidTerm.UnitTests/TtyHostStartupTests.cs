using Ai.Tlbx.MidTerm.Common.Shells;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TtyHostStartupTests
{
    [Fact]
    public void BuildShellLaunch_AppendsPowerShellBookmarkToStartupCommand()
    {
        var shell = new ShellRegistry().GetConfigurationByName("Pwsh")!;

        var launch = TtyHost.Program.BuildShellLaunch(shell, "codex --yolo");

        Assert.Empty(launch.DeferredInput.ToArray());
        Assert.Equal("-Command", launch.Arguments[^2]);
        Assert.EndsWith(";codex --yolo", launch.Arguments[^1], StringComparison.Ordinal);
        Assert.Equal("-NoExit", launch.Arguments[1]);
    }

    [Fact]
    public void BuildShellLaunch_UsesPersistentCmdCommand()
    {
        var shell = new ShellRegistry().GetConfigurationByName("Cmd")!;

        var launch = TtyHost.Program.BuildShellLaunch(shell, "codex --yolo");

        Assert.Empty(launch.DeferredInput.ToArray());
        Assert.Equal(["/K", "codex --yolo"], launch.Arguments);
    }
}
