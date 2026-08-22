using Ai.Tlbx.MidTerm.Common.Shells;
using System.Text;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TtyHostStartupTests
{
    [Fact]
    public void BuildShellLaunch_DefersPowerShellBookmarkUntilShellStartup()
    {
        var shell = new ShellRegistry().GetConfigurationByName("Pwsh")!;

        var launch = TtyHost.Program.BuildShellLaunch(shell, "codex --yolo");

        Assert.Equal("codex --yolo\r", Encoding.UTF8.GetString(launch.DeferredInput.Span));
        Assert.Equal("-Command", launch.Arguments[^2]);
        Assert.Equal("-NoExit", launch.Arguments[1]);
        Assert.DoesNotContain("codex --yolo", launch.Arguments[^1], StringComparison.Ordinal);
    }

    [Fact]
    public void BuildShellLaunch_UsesPersistentCmdCommand()
    {
        var shell = new ShellRegistry().GetConfigurationByName("Cmd")!;

        var launch = TtyHost.Program.BuildShellLaunch(shell, "codex --yolo");

        Assert.Empty(launch.DeferredInput.ToArray());
        Assert.Equal(["/K", "codex --yolo"], launch.Arguments);
    }

    [Fact]
    public void InputReadinessDetector_RecognizesSplitBracketedPasteSequence()
    {
        var detector = new TtyHost.TerminalInputReadinessDetector();

        Assert.False(detector.Observe("\u001b[?20"u8));
        Assert.True(detector.Observe("04h"u8));
        Assert.True(detector.Observe(ReadOnlySpan<byte>.Empty));
    }
}
