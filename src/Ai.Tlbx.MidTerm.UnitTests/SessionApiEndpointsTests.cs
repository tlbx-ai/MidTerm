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
}
