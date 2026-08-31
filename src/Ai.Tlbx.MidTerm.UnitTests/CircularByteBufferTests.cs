using System.Text;
using Ai.Tlbx.MidTerm.TtyHost;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class CircularByteBufferTests
{
    [Fact]
    public void Overflow_AdvancesTailPastAnIncompleteCsiSequence()
    {
        using var buffer = new CircularByteBuffer(4);

        buffer.Write(Encoding.ASCII.GetBytes("A\x1b[31mB"));

        Assert.Equal("B", Encoding.ASCII.GetString(buffer.ToArray()));
        Assert.Equal(6UL, buffer.TailPosition);
    }

    [Fact]
    public void Overflow_AdvancesTailPastASplitUtf8Character()
    {
        using var buffer = new CircularByteBuffer(2);

        buffer.Write(Encoding.UTF8.GetBytes("A€B"));

        Assert.Equal("B", Encoding.UTF8.GetString(buffer.ToArray()));
        Assert.Equal(4UL, buffer.TailPosition);
    }

    [Fact]
    public void Overflow_DiscardsSequenceSuffixAcrossWritesUntilAParserBoundary()
    {
        using var buffer = new CircularByteBuffer(2);

        buffer.Write(Encoding.ASCII.GetBytes("\x1b["));
        buffer.Write(Encoding.ASCII.GetBytes("31"));
        Assert.Empty(buffer.ToArray());

        buffer.Write(Encoding.ASCII.GetBytes("mX"));

        Assert.Equal("X", Encoding.ASCII.GetString(buffer.ToArray()));
        Assert.Equal(5UL, buffer.TailPosition);
    }

    [Theory]
    [InlineData("\x1b]0;window title\x07X")]
    [InlineData("\x1b]0;window title\x1b\\X")]
    [InlineData("\x1bP1;2|payload\x1b\\X")]
    public void Overflow_AdvancesPastTerminalStrings(string value)
    {
        var data = Encoding.ASCII.GetBytes(value);
        using var buffer = new CircularByteBuffer(2);

        buffer.Write(data);

        Assert.Equal("X", Encoding.ASCII.GetString(buffer.ToArray()));
        Assert.Equal((ulong)(data.Length - 1), buffer.TailPosition);
    }

    [Fact]
    public void CopyTailTo_AdvancesRequestedTailPastAnIncompleteControlSequence()
    {
        using var buffer = new CircularByteBuffer(16);
        buffer.Write(Encoding.ASCII.GetBytes("A\x1b[31mB"));
        Span<byte> destination = stackalloc byte[4];

        var copied = buffer.CopyTailTo(destination, out var sequenceStart);

        Assert.Equal(1, copied);
        Assert.Equal(6UL, sequenceStart);
        Assert.Equal("B", Encoding.ASCII.GetString(destination[..copied]));
    }

    [Fact]
    public void CopyTailTo_LeavesExactGroundStateTextTailUnchanged()
    {
        using var buffer = new CircularByteBuffer(16);
        buffer.Write(Encoding.ASCII.GetBytes("abcdef"));
        Span<byte> destination = stackalloc byte[4];

        var copied = buffer.CopyTailTo(destination, out var sequenceStart);

        Assert.Equal(4, copied);
        Assert.Equal(2UL, sequenceStart);
        Assert.Equal("cdef", Encoding.ASCII.GetString(destination[..copied]));
    }

    [Fact]
    public void TryCopySince_PreservesAnExactIncrementalCursorInsideCsi()
    {
        using var buffer = new CircularByteBuffer(16);
        buffer.Write(Encoding.ASCII.GetBytes("\x1b[31mX"));
        Span<byte> destination = stackalloc byte[8];

        Assert.True(buffer.TryCopySince(2, destination, out var copied));
        Assert.Equal("31mX", Encoding.ASCII.GetString(destination[..copied]));
    }

    [Fact]
    public void TryCopySince_RejectsCursorsOutsideRetainedSequenceRange()
    {
        using var buffer = new CircularByteBuffer(4);
        buffer.Write(Encoding.ASCII.GetBytes("abcdef"));
        Span<byte> destination = stackalloc byte[4];

        Assert.False(buffer.TryCopySince(1, destination, out var beforeTailBytes));
        Assert.Equal(0, beforeTailBytes);
        Assert.False(buffer.TryCopySince(7, destination, out var afterHeadBytes));
        Assert.Equal(0, afterHeadBytes);
    }

    [Fact]
    public void TryCopySince_ReturnsTheContiguousSuffixAtAnExactCursor()
    {
        using var buffer = new CircularByteBuffer(8);
        buffer.Write(Encoding.ASCII.GetBytes("abcdef"));
        Span<byte> destination = stackalloc byte[4];

        Assert.True(buffer.TryCopySince(3, destination, out var bytesCopied));
        Assert.Equal(3, bytesCopied);
        Assert.Equal("def", Encoding.ASCII.GetString(destination[..bytesCopied]));
    }
}
