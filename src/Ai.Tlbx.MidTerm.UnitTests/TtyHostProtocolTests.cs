using System.Text;
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

    [Fact]
    public void OutputFrame_RoundTrips_SequenceAndPayload()
    {
        var payload = Encoding.UTF8.GetBytes("hello");
        byte[]? frame = null;

        TtyHostProtocol.WriteOutputMessage(123UL, 90, 31, payload, span => frame = span.ToArray());

        Assert.NotNull(frame);
        Assert.True(TtyHostProtocol.TryReadHeader(frame!, out var type, out var payloadLength));
        Assert.Equal(TtyHostMessageType.Output, type);

        var parsedPayload = frame!.AsSpan(TtyHostProtocol.HeaderSize, payloadLength);
        Assert.Equal(123UL, TtyHostProtocol.ParseOutputSequenceStart(parsedPayload));
        Assert.Equal((90, 31), TtyHostProtocol.ParseOutputDimensions(parsedPayload));
        Assert.Equal(payload, TtyHostProtocol.GetOutputData(parsedPayload).ToArray());
    }

    [Fact]
    public void GetBuffer_RoundTrips_TailRequestAndSnapshot()
    {
        var requestFrame = TtyHostProtocol.CreateGetBuffer(4096, TerminalReplayReason.BufferRefreshTailReplay);

        Assert.True(TtyHostProtocol.TryReadHeader(requestFrame, out var requestType, out var requestPayloadLength));
        Assert.Equal(TtyHostMessageType.GetBuffer, requestType);

        var request = TtyHostProtocol.ParseGetBuffer(requestFrame.AsSpan(TtyHostProtocol.HeaderSize, requestPayloadLength));
        Assert.NotNull(request);
        Assert.Equal(4096, request!.MaxBytes);
        Assert.Equal(TerminalReplayReason.BufferRefreshTailReplay, request.Reason);

        byte[]? bufferFrame = null;
        var snapshotData = Encoding.UTF8.GetBytes("tail");
        TtyHostProtocol.WriteBufferResponse(222UL, snapshotData, span => bufferFrame = span.ToArray());

        Assert.NotNull(bufferFrame);
        Assert.True(TtyHostProtocol.TryReadHeader(bufferFrame!, out var bufferType, out var bufferPayloadLength));
        Assert.Equal(TtyHostMessageType.Buffer, bufferType);

        var snapshot = TtyHostProtocol.ParseBuffer(bufferFrame!.AsSpan(TtyHostProtocol.HeaderSize, bufferPayloadLength));
        Assert.Equal(222UL, snapshot.SequenceStart);
        Assert.Equal(snapshotData, snapshot.Data);
    }

    [Fact]
    public void GetBuffer_RoundTrips_UncappedRequest()
    {
        var requestFrame = TtyHostProtocol.CreateGetBuffer(reason: TerminalReplayReason.ReconnectTailReplay);

        Assert.True(TtyHostProtocol.TryReadHeader(requestFrame, out var requestType, out var requestPayloadLength));
        Assert.Equal(TtyHostMessageType.GetBuffer, requestType);

        var request = TtyHostProtocol.ParseGetBuffer(requestFrame.AsSpan(TtyHostProtocol.HeaderSize, requestPayloadLength));
        Assert.NotNull(request);
        Assert.Null(request!.MaxBytes);
        Assert.Equal(TerminalReplayReason.ReconnectTailReplay, request.Reason);
    }

    [Fact]
    public void GetBuffer_RoundTrips_QuickResumeReason()
    {
        var requestFrame = TtyHostProtocol.CreateGetBuffer(65536, TerminalReplayReason.QuickResumeTailReplay);

        Assert.True(TtyHostProtocol.TryReadHeader(requestFrame, out var requestType, out var requestPayloadLength));
        Assert.Equal(TtyHostMessageType.GetBuffer, requestType);

        var request = TtyHostProtocol.ParseGetBuffer(requestFrame.AsSpan(TtyHostProtocol.HeaderSize, requestPayloadLength));
        Assert.NotNull(request);
        Assert.Equal(65536, request!.MaxBytes);
        Assert.Equal(TerminalReplayReason.QuickResumeTailReplay, request.Reason);
    }

    [Fact]
    public void DataLoss_RoundTrips_ReasonAndDroppedBytes()
    {
        var frame = TtyHostProtocol.CreateDataLoss(new TtyHostDataLossPayload
        {
            Reason = TerminalReplayReason.MthostIpcOverflow,
            DroppedBytes = 8192
        });

        Assert.True(TtyHostProtocol.TryReadHeader(frame, out var type, out var payloadLength));
        Assert.Equal(TtyHostMessageType.DataLoss, type);

        var payload = TtyHostProtocol.ParseDataLoss(frame.AsSpan(TtyHostProtocol.HeaderSize, payloadLength));
        Assert.NotNull(payload);
        Assert.Equal(TerminalReplayReason.MthostIpcOverflow, payload!.Reason);
        Assert.Equal(8192, payload.DroppedBytes);
    }
}
