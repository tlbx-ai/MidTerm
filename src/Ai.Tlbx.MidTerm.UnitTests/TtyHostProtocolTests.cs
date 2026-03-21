using Ai.Tlbx.MidTerm.Common.Protocol;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class TtyHostProtocolTests
{
    [Fact]
    public void CreateInfoResponse_RoundTrips_SessionInfo()
    {
        var info = new SessionInfo
        {
            Id = "abc12345",
            Pid = 101,
            HostPid = 202,
            ShellType = "Pwsh",
            Cols = 120,
            Rows = 30,
            IsRunning = true,
            Order = 3,
            TtyHostVersion = "1.2.3"
        };

        var frame = TtyHostProtocol.CreateInfoResponse(info);
        Assert.True(TtyHostProtocol.TryReadHeader(frame, out var type, out var payloadLength));
        Assert.Equal(TtyHostMessageType.Info, type);

        var payload = frame.AsSpan(TtyHostProtocol.HeaderSize, payloadLength);
        var parsed = TtyHostProtocol.ParseInfo(payload);

        Assert.NotNull(parsed);
        Assert.Equal(info.Id, parsed!.Id);
        Assert.Equal(info.HostPid, parsed.HostPid);
        Assert.Equal(info.ShellType, parsed.ShellType);
    }

    [Fact]
    public void SetClipboardImage_RoundTrips_RequestAndAck()
    {
        var frame = TtyHostProtocol.CreateSetClipboardImage(@"C:\temp\image.png", "image/png");

        Assert.True(TtyHostProtocol.TryReadHeader(frame, out var type, out var payloadLength));
        Assert.Equal(TtyHostMessageType.SetClipboardImage, type);

        var request = TtyHostProtocol.ParseSetClipboardImage(
            frame.AsSpan(TtyHostProtocol.HeaderSize, payloadLength));

        Assert.NotNull(request);
        Assert.Equal(@"C:\temp\image.png", request!.FilePath);
        Assert.Equal("image/png", request.MimeType);

        var ack = TtyHostProtocol.CreateSetClipboardImageAck(success: true);
        Assert.True(TtyHostProtocol.TryReadHeader(ack, out var ackType, out var ackPayloadLength));
        Assert.Equal(TtyHostMessageType.SetClipboardImageAck, ackType);

        var response = TtyHostProtocol.ParseSetClipboardImageAck(
            ack.AsSpan(TtyHostProtocol.HeaderSize, ackPayloadLength));

        Assert.NotNull(response);
        Assert.True(response!.Success);
        Assert.Null(response.Error);
    }

    [Fact]
    public void Attach_RoundTrips_RequestAndAck()
    {
        var requestFrame = TtyHostProtocol.CreateAttachRequest(new TtyHostAttachRequest
        {
            InstanceId = "inst1234abcd5678",
            OwnerToken = "owner-token"
        });

        Assert.True(TtyHostProtocol.TryReadHeader(requestFrame, out var requestType, out var requestPayloadLength));
        Assert.Equal(TtyHostMessageType.Attach, requestType);

        var request = TtyHostProtocol.ParseAttachRequest(
            requestFrame.AsSpan(TtyHostProtocol.HeaderSize, requestPayloadLength));

        Assert.NotNull(request);
        Assert.Equal("inst1234abcd5678", request!.InstanceId);
        Assert.Equal("owner-token", request.OwnerToken);

        var ackFrame = TtyHostProtocol.CreateAttachAck(true, "ok");
        Assert.True(TtyHostProtocol.TryReadHeader(ackFrame, out var ackType, out var ackPayloadLength));
        Assert.Equal(TtyHostMessageType.AttachAck, ackType);

        var ack = TtyHostProtocol.ParseAttachAck(
            ackFrame.AsSpan(TtyHostProtocol.HeaderSize, ackPayloadLength));

        Assert.NotNull(ack);
        Assert.True(ack!.Accepted);
        Assert.Equal("ok", ack.Message);
    }
}
