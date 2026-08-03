using System.Text;
using Ai.Tlbx.MidTerm.TtyHost;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TerminalReplayStateTrackerTests
{
    [Fact]
    public void StateAtReplayStart_PreservesAlternateScreenAfterEnterSequenceAgesOut()
    {
        var tracker = new TerminalReplayStateTracker();
        var enter = Encoding.ASCII.GetBytes("\x1b[?1049h");

        tracker.Consume(enter, 0);
        tracker.Consume(Encoding.ASCII.GetBytes("screen contents"), (ulong)enter.Length);
        tracker.TrimBefore((ulong)enter.Length);

        var state = tracker.GetStateAt((ulong)enter.Length);
        Assert.True(state.AlternateScreenActive);
        Assert.Equal(1049, state.AlternateScreenMode);
    }

    [Fact]
    public void StateAtReplayStart_AppliesOnlyTransitionsCompletedBeforeThatByte()
    {
        var tracker = new TerminalReplayStateTracker();
        var enter = Encoding.ASCII.GetBytes("\x1b[?1047h");
        var exit = Encoding.ASCII.GetBytes("\x1b[?1047l");

        tracker.Consume(enter, 0);
        tracker.Consume(exit, (ulong)enter.Length);

        Assert.Equal(1047, tracker.GetStateAt((ulong)enter.Length).AlternateScreenMode);
        Assert.Equal(1047, tracker.GetStateAt((ulong)(enter.Length + exit.Length - 1)).AlternateScreenMode);
        Assert.False(tracker.GetStateAt((ulong)(enter.Length + exit.Length)).AlternateScreenActive);
    }

    [Fact]
    public void Consume_RecognizesPrivateModeSequenceSplitAcrossPtyReads()
    {
        var tracker = new TerminalReplayStateTracker();

        tracker.Consume(Encoding.ASCII.GetBytes("\x1b[?10"), 0);
        tracker.Consume(Encoding.ASCII.GetBytes("49hframe"), 5);

        Assert.Equal(1049, tracker.GetStateAt(9).AlternateScreenMode);
    }

    [Fact]
    public void Consume_RisReturnsReplayStateToNormalBuffer()
    {
        var tracker = new TerminalReplayStateTracker();
        var data = Encoding.ASCII.GetBytes("\u001b[?47hcontent\u001bc");

        tracker.Consume(data, 0);

        Assert.False(tracker.GetStateAt((ulong)data.Length).AlternateScreenActive);
    }

    [Fact]
    public void Consume_IgnoresLookalikeTextWithoutCsiIntroducer()
    {
        var tracker = new TerminalReplayStateTracker();
        var data = Encoding.ASCII.GetBytes("status [?1049h still text");

        tracker.Consume(data, 0);

        Assert.False(tracker.GetStateAt((ulong)data.Length).AlternateScreenActive);
    }
}
