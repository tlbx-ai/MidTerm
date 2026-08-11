using System.Text;
using Ai.Tlbx.MidTerm.TtyHost;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class KittyGraphicsCapabilityResponderTests
{
    private const string Query = "\x1b_Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";

    [Fact]
    public void Consume_AnswersOpenTuiCapabilityQuery()
    {
        var responder = new KittyGraphicsCapabilityResponder();

        var responses = responder.Consume(Encoding.ASCII.GetBytes(Query));

        var response = Assert.Single(Assert.IsType<List<byte[]>>(responses));
        Assert.Equal("\x1b_Gi=31337;OK\x1b\\", Encoding.ASCII.GetString(response));
    }

    [Fact]
    public void Consume_HandlesQuerySplitAcrossPtyReads()
    {
        var responder = new KittyGraphicsCapabilityResponder();
        var bytes = Encoding.ASCII.GetBytes(Query);

        Assert.Null(responder.Consume(bytes.AsSpan(0, 7)));
        Assert.Null(responder.Consume(bytes.AsSpan(7, 19)));
        var responses = responder.Consume(bytes.AsSpan(26));

        Assert.Single(Assert.IsType<List<byte[]>>(responses));
    }

    [Fact]
    public void Consume_DoesNotAnswerImageTransmission()
    {
        var responder = new KittyGraphicsCapabilityResponder();
        var image = Encoding.ASCII.GetBytes("\x1b_Ga=T,f=100,t=d,i=31338;AAAA\x1b\\");

        Assert.Null(responder.Consume(image));
    }

    [Fact]
    public void Consume_AnswersPrimaryDeviceAttributesAcrossPtyReads()
    {
        var responder = new KittyGraphicsCapabilityResponder();

        Assert.Null(responder.Consume(Encoding.ASCII.GetBytes("before\x1b[")));
        var responses = responder.Consume(Encoding.ASCII.GetBytes("cafter"));

        var response = Assert.Single(Assert.IsType<List<byte[]>>(responses));
        Assert.Equal("\x1b[?62;4;9;22c", Encoding.ASCII.GetString(response));
        Assert.True(responder.IsDuplicateClientResponse(response));
    }

    [Fact]
    public void Consume_RejectsFileTransferWithoutClaimingBrowserFilesystemAccess()
    {
        var responder = new KittyGraphicsCapabilityResponder();
        var query = Encoding.ASCII.GetBytes("\x1b_Gi=7,a=q,t=f,f=100;AAAA\x1b\\");

        var responses = responder.Consume(query);

        var response = Assert.Single(Assert.IsType<List<byte[]>>(responses));
        Assert.Equal(
            "\x1b_Gi=7;EINVAL:unsupported transmission medium\x1b\\",
            Encoding.ASCII.GetString(response));
    }

    [Fact]
    public void IsDuplicateClientResponse_SuppressesOnlyResponsesAlreadySentByHost()
    {
        var responder = new KittyGraphicsCapabilityResponder();
        var response = Assert.Single(Assert.IsType<List<byte[]>>(
            responder.Consume(Encoding.ASCII.GetBytes(Query))));

        Assert.True(responder.IsDuplicateClientResponse(response));
        Assert.True(responder.IsDuplicateClientResponse(response));
        Assert.False(responder.IsDuplicateClientResponse(
            Encoding.ASCII.GetBytes("\x1b_Gi=99;OK\x1b\\")));
        Assert.False(responder.IsDuplicateClientResponse(Encoding.ASCII.GetBytes("echo OK")));
    }
}
