using System.Text;
using Ai.Tlbx.MidTerm.TtyHost;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TerminalColorQueryGuardTests
{
    [Fact]
    public void FreshColorResponse_IsForwardedOnce()
    {
        var time = new FakeTimeProvider();
        var guard = new TerminalColorQueryGuard(time);
        guard.ObservePtyOutput(Encoding.ASCII.GetBytes("\x1b]10;?\x1b\\"));
        var response = Encoding.ASCII.GetBytes("\x1b]10;rgb:f2f2/f2f2/f2f2\x1b\\");

        Assert.False(guard.ShouldSuppressClientResponse(response));
        Assert.True(guard.ShouldSuppressClientResponse(response));
    }

    [Fact]
    public void ReplayedColorQueryResponse_AfterApplicationTimeout_IsSuppressed()
    {
        var time = new FakeTimeProvider();
        var guard = new TerminalColorQueryGuard(time);
        guard.ObservePtyOutput(Encoding.ASCII.GetBytes("\x1b]11;?\x1b\\"));

        time.Advance(TimeSpan.FromSeconds(2));

        Assert.True(guard.ShouldSuppressClientResponse(
            Encoding.ASCII.GetBytes("\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\")));
    }

    [Fact]
    public void QueryScanner_HandlesSplitOscAndBellTerminator()
    {
        var time = new FakeTimeProvider();
        var guard = new TerminalColorQueryGuard(time);
        guard.ObservePtyOutput(Encoding.ASCII.GetBytes("before\x1b]1"));
        guard.ObservePtyOutput(Encoding.ASCII.GetBytes("2;?\u0007after"));

        time.Advance(TimeSpan.FromSeconds(2));

        Assert.True(guard.ShouldSuppressClientResponse(
            Encoding.ASCII.GetBytes("\x1b]12;rgb:ffff/0000/ffff\x07")));
    }

    [Fact]
    public void StackedForegroundAndBackgroundQueries_AreTrackedSeparately()
    {
        var time = new FakeTimeProvider();
        var guard = new TerminalColorQueryGuard(time);
        guard.ObservePtyOutput(Encoding.ASCII.GetBytes("\x1b]10;?;?\x1b\\"));

        time.Advance(TimeSpan.FromSeconds(2));

        Assert.True(guard.ShouldSuppressClientResponse(
            Encoding.ASCII.GetBytes("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")));
        Assert.True(guard.ShouldSuppressClientResponse(
            Encoding.ASCII.GetBytes("\x1b]11;rgb:0000/0000/0000\x1b\\")));
    }

    [Fact]
    public void OrdinaryInputAndUnmatchedResponses_AreNeverSuppressed()
    {
        var guard = new TerminalColorQueryGuard(new FakeTimeProvider());
        guard.ObservePtyOutput(Encoding.ASCII.GetBytes("\x1b]10;?\x1b\\"));

        Assert.False(guard.ShouldSuppressClientResponse("hello"u8));
        Assert.False(guard.ShouldSuppressClientResponse("\x1b[A"u8));
        Assert.False(guard.ShouldSuppressClientResponse(
            Encoding.ASCII.GetBytes("\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\")));
    }
}
