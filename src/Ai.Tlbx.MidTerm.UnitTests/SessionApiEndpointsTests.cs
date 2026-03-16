using System.Text;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionApiEndpointsTests
{
    [Fact]
    public void TryGetInputBytes_TextAppendNewline_UsesCarriageReturn()
    {
        var request = new SessionInputRequest
        {
            Text = "Write-Output test",
            AppendNewline = true
        };

        var ok = SessionApiEndpoints.TryGetInputBytes(request, out var data, out var error);

        Assert.True(ok);
        Assert.Equal("", error);
        Assert.Equal("Write-Output test\r", Encoding.UTF8.GetString(data));
    }

    [Fact]
    public void TryGetInputBytes_Base64AppendNewline_UsesCarriageReturn()
    {
        var request = new SessionInputRequest
        {
            Base64 = Convert.ToBase64String([0x41, 0x42]),
            AppendNewline = true
        };

        var ok = SessionApiEndpoints.TryGetInputBytes(request, out var data, out var error);

        Assert.True(ok);
        Assert.Equal("", error);
        Assert.Equal([0x41, 0x42, 0x0D], data);
    }

    [Fact]
    public void TryGetKeyInputBytes_TranslatesNamedKeys()
    {
        var request = new SessionKeyInputRequest
        {
            Keys = ["Up", "Enter"]
        };

        var ok = SessionApiEndpoints.TryGetKeyInputBytes(request, out var data, out var error);

        Assert.True(ok);
        Assert.Equal("", error);
        Assert.Equal([0x1B, 0x5B, 0x41, 0x0D], data);
    }

    [Fact]
    public void TryGetKeyInputBytes_RejectsEmptyNonLiteralKeys()
    {
        var request = new SessionKeyInputRequest
        {
            Keys = ["Enter", ""]
        };

        var ok = SessionApiEndpoints.TryGetKeyInputBytes(request, out var data, out var error);

        Assert.False(ok);
        Assert.Equal("Keys cannot be empty.", error);
        Assert.Empty(data);
    }

    [Fact]
    public void TryGetPromptInputSequence_DefaultsToEnterSubmitWithoutInterrupt()
    {
        var request = new SessionPromptRequest
        {
            Text = "status"
        };

        var ok = SessionApiEndpoints.TryGetPromptInputSequence(
            request,
            out var interruptData,
            out var promptData,
            out var submitData,
            out var interruptDelayMs,
            out var submitDelayMs,
            out var error);

        Assert.True(ok);
        Assert.Equal("", error);
        Assert.Null(interruptData);
        Assert.Equal("status", Encoding.UTF8.GetString(promptData));
        Assert.Equal([0x0D], submitData);
        Assert.Equal(150, interruptDelayMs);
        Assert.Equal(300, submitDelayMs);
    }

    [Fact]
    public void TryGetPromptInputSequence_InterruptFirst_UsesConfiguredKeySequences()
    {
        var request = new SessionPromptRequest
        {
            Text = "continue",
            InterruptFirst = true,
            InterruptDelayMs = 25,
            SubmitDelayMs = 50
        };

        var ok = SessionApiEndpoints.TryGetPromptInputSequence(
            request,
            out var interruptData,
            out var promptData,
            out var submitData,
            out var interruptDelayMs,
            out var submitDelayMs,
            out var error);

        Assert.True(ok);
        Assert.Equal("", error);
        Assert.NotNull(interruptData);
        Assert.Equal([(byte)0x03], interruptData);
        Assert.Equal("continue", Encoding.UTF8.GetString(promptData));
        Assert.Equal([0x0D], submitData);
        Assert.Equal(25, interruptDelayMs);
        Assert.Equal(50, submitDelayMs);
    }

    [Fact]
    public void TryGetPromptInputSequence_RejectsNegativeDelays()
    {
        var request = new SessionPromptRequest
        {
            Text = "status",
            SubmitDelayMs = -1
        };

        var ok = SessionApiEndpoints.TryGetPromptInputSequence(
            request,
            out var interruptData,
            out var promptData,
            out var submitData,
            out var interruptDelayMs,
            out var submitDelayMs,
            out var error);

        Assert.False(ok);
        Assert.Equal("Delay values cannot be negative.", error);
        Assert.Null(interruptData);
        Assert.Empty(promptData);
        Assert.Empty(submitData);
        Assert.Equal(0, interruptDelayMs);
        Assert.Equal(0, submitDelayMs);
    }
}
