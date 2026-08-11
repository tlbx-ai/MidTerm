using System.Runtime.Versioning;
using Ai.Tlbx.MidTerm.TtyHost.Process;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

[SupportedOSPlatform("windows")]
public sealed class WindowsProcessMonitorTests
{
    [Theory]
    [InlineData(0, 0, WindowsProcessMonitor.ActivePollIntervalMs)]
    [InlineData(0, 1999, WindowsProcessMonitor.ActivePollIntervalMs)]
    [InlineData(0, 2000, WindowsProcessMonitor.IdlePollIntervalMs)]
    [InlineData(1000, 31000, WindowsProcessMonitor.IdlePollIntervalMs)]
    public void ResolvePollDelay_UsesFastPollingOnlyAroundTerminalActivity(
        long lastActivityMs,
        long nowMs,
        int expectedDelayMs)
    {
        Assert.Equal(expectedDelayMs, WindowsProcessMonitor.ResolvePollDelay(lastActivityMs, nowMs));
    }
}
