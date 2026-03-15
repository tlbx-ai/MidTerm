using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TerminalOutputSanitizerTests
{
    [Fact]
    public void StripEscapeSequences_RemovesAnsiCodesAndControlBytes()
    {
        var text = "\u001b[31merror\u001b[0m\u0007\r\nok";

        var result = TerminalOutputSanitizer.StripEscapeSequences(text);

        Assert.Equal("error\r\nok", result);
    }

    [Fact]
    public void TailLines_ReturnsLastRequestedLines()
    {
        var result = TerminalOutputSanitizer.TailLines("a\nb\nc\nd", 2, out var totalLines, out var returnedLines);

        Assert.Equal("c\nd", result);
        Assert.Equal(4, totalLines);
        Assert.Equal(2, returnedLines);
    }

    [Fact]
    public void CountBellEvents_IgnoresOscTerminators()
    {
        ReadOnlySpan<byte> data =
        [
            0x1B, 0x5D, (byte)'0', (byte)';', (byte)'t', (byte)'i', (byte)'t', (byte)'l', (byte)'e', 0x07,
            0x07,
            0x1B, 0x5D, (byte)'7', (byte)';', (byte)'/', (byte)'t', (byte)'m', (byte)'p', 0x1B, 0x5C
        ];

        var result = TerminalOutputSanitizer.CountBellEvents(data);

        Assert.Equal(1, result);
    }
}
