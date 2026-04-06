using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TerminalEnvironmentVariableParserTests
{
    [Fact]
    public void Parse_ReturnsNullForBlankInput()
    {
        Assert.Null(TerminalEnvironmentVariableParser.Parse(null));
        Assert.Null(TerminalEnvironmentVariableParser.Parse(""));
        Assert.Null(TerminalEnvironmentVariableParser.Parse("   \r\n  "));
    }

    [Fact]
    public void Parse_PreservesValuesAfterFirstEqualsAndAllowsEmptyValues()
    {
        var parsed = TerminalEnvironmentVariableParser.Parse("FOO=bar\nEMPTY=\nJSON={\"a\":1}\nPATH=a=b=c");

        Assert.NotNull(parsed);
        Assert.Equal("bar", parsed["FOO"]);
        Assert.Equal(string.Empty, parsed["EMPTY"]);
        Assert.Equal("{\"a\":1}", parsed["JSON"]);
        Assert.Equal("a=b=c", parsed["PATH"]);
    }

    [Fact]
    public void Parse_IgnoresMalformedAndReservedKeys()
    {
        var parsed = TerminalEnvironmentVariableParser.Parse(
            "VALID=yes\nMIDTERM_TOKEN=blocked\nNOT VALID=no\nNOEQUALS\n=missingkey");

        Assert.NotNull(parsed);
        Assert.Equal("yes", parsed["VALID"]);
        Assert.False(parsed.ContainsKey("MIDTERM_TOKEN"));
        Assert.False(parsed.ContainsKey("NOT VALID"));
    }
}
