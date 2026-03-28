using Ai.Tlbx.MidTerm.Common.Process;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ForegroundChildSelectorTests
{
    [Fact]
    public void SelectBest_PrefersNewestConsoleChildOverOlderGuiChild()
    {
        var guiChild = new ForegroundChildCandidate(
            Pid: 200,
            Name: "taskmgr",
            HasVisibleWindow: true,
            StartedAtUtc: new DateTimeOffset(2026, 3, 28, 9, 0, 0, TimeSpan.Zero));
        var consoleChild = new ForegroundChildCandidate(
            Pid: 220,
            Name: "node",
            HasVisibleWindow: false,
            StartedAtUtc: new DateTimeOffset(2026, 3, 28, 9, 1, 0, TimeSpan.Zero));

        var selected = ForegroundChildSelector.SelectBest([guiChild, consoleChild]);

        Assert.NotNull(selected);
        Assert.Equal(consoleChild.Pid, selected.Value.Pid);
    }

    [Fact]
    public void SelectBest_PrefersRealToolOverShellWrapperWhenStartedAtMatches()
    {
        var wrapperChild = new ForegroundChildCandidate(
            Pid: 300,
            Name: "cmd",
            HasVisibleWindow: false,
            StartedAtUtc: new DateTimeOffset(2026, 3, 28, 9, 2, 0, TimeSpan.Zero));
        var toolChild = new ForegroundChildCandidate(
            Pid: 301,
            Name: "node",
            HasVisibleWindow: false,
            StartedAtUtc: new DateTimeOffset(2026, 3, 28, 9, 2, 0, TimeSpan.Zero));

        var selected = ForegroundChildSelector.SelectBest([wrapperChild, toolChild]);

        Assert.NotNull(selected);
        Assert.Equal(toolChild.Pid, selected.Value.Pid);
    }
}
