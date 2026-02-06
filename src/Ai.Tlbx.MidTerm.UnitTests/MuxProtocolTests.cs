using System.IO.Compression;
using System.Text;
using Ai.Tlbx.MidTerm.Services;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public class MuxProtocolTests
{
    [Fact]
    public void CreateOutputFrame_RoundTrip_ParsesCorrectly()
    {
        var sessionId = "abc12345";
        var cols = 120;
        var rows = 40;
        var data = Encoding.UTF8.GetBytes("Hello, World!");

        var frame = MuxProtocol.CreateOutputFrame(sessionId, cols, rows, data);

        Assert.True(MuxProtocol.TryParseFrame(frame, out var type, out var parsedSessionId, out var payload));
        Assert.Equal(MuxProtocol.TypeTerminalOutput, type);
        Assert.Equal(sessionId, parsedSessionId);

        var (parsedCols, parsedRows) = MuxProtocol.ParseOutputDimensions(payload);
        Assert.Equal(cols, parsedCols);
        Assert.Equal(rows, parsedRows);

        var outputData = MuxProtocol.GetOutputData(payload);
        Assert.Equal(data, outputData.ToArray());
    }

    [Fact]
    public void CreateCompressedOutputFrame_Decompresses_ToOriginalData()
    {
        var sessionId = "xyz98765";
        var cols = 80;
        var rows = 24;
        var originalData = Encoding.UTF8.GetBytes(new string('A', 10000));

        var frame = MuxProtocol.CreateCompressedOutputFrame(sessionId, cols, rows, originalData);

        Assert.Equal(MuxProtocol.TypeCompressedOutput, frame[0]);
        Assert.Equal(sessionId, Encoding.ASCII.GetString(frame, 1, 8));

        var parsedCols = BitConverter.ToUInt16(frame, 9);
        var parsedRows = BitConverter.ToUInt16(frame, 11);
        Assert.Equal(cols, parsedCols);
        Assert.Equal(rows, parsedRows);

        var uncompressedLen = BitConverter.ToInt32(frame, 13);
        Assert.Equal(originalData.Length, uncompressedLen);

        using var compressedStream = new MemoryStream(frame, MuxProtocol.CompressedOutputHeaderSize, frame.Length - MuxProtocol.CompressedOutputHeaderSize);
        using var gzip = new GZipStream(compressedStream, CompressionMode.Decompress);
        using var resultStream = new MemoryStream();
        gzip.CopyTo(resultStream);

        Assert.Equal(originalData, resultStream.ToArray());
    }

    [Fact]
    public void TryParseFrame_TruncatedData_ReturnsFalse()
    {
        var tooShort = new byte[MuxProtocol.HeaderSize - 1];

        var result = MuxProtocol.TryParseFrame(tooShort, out _, out _, out _);

        Assert.False(result);
    }

    [Fact]
    public void TryParseFrame_ExactHeaderSize_Succeeds()
    {
        var frame = new byte[MuxProtocol.HeaderSize];
        frame[0] = MuxProtocol.TypeResync;
        Encoding.ASCII.GetBytes("session1").CopyTo(frame, 1);

        var result = MuxProtocol.TryParseFrame(frame, out var type, out var sessionId, out var payload);

        Assert.True(result);
        Assert.Equal(MuxProtocol.TypeResync, type);
        Assert.Equal("session1", sessionId);
        Assert.Empty(payload.ToArray());
    }

    [Fact]
    public void TryParseFrame_WithPayload_ExtractsCorrectly()
    {
        var payloadData = new byte[] { 0x01, 0x02, 0x03, 0x04 };
        var frame = new byte[MuxProtocol.HeaderSize + payloadData.Length];
        frame[0] = MuxProtocol.TypeTerminalInput;
        Encoding.ASCII.GetBytes("inputsid").CopyTo(frame, 1);
        payloadData.CopyTo(frame, MuxProtocol.HeaderSize);

        var result = MuxProtocol.TryParseFrame(frame, out var type, out var sessionId, out var payload);

        Assert.True(result);
        Assert.Equal(MuxProtocol.TypeTerminalInput, type);
        Assert.Equal("inputsid", sessionId);
        Assert.Equal(payloadData, payload.ToArray());
    }

    [Fact]
    public void ParseResizePayload_ExtractsDimensions()
    {
        var payload = MuxProtocol.CreateResizePayload(132, 50);

        var (cols, rows) = MuxProtocol.ParseResizePayload(payload);

        Assert.Equal(132, cols);
        Assert.Equal(50, rows);
    }

    [Fact]
    public void ParseResizePayload_TooShort_ReturnsDefaults()
    {
        var tooShort = new byte[3];

        var (cols, rows) = MuxProtocol.ParseResizePayload(tooShort);

        Assert.Equal(80, cols);
        Assert.Equal(24, rows);
    }

    [Fact]
    public void ParseOutputDimensions_TooShort_ReturnsZeros()
    {
        var tooShort = new byte[3];

        var (cols, rows) = MuxProtocol.ParseOutputDimensions(tooShort);

        Assert.Equal(0, cols);
        Assert.Equal(0, rows);
    }

    [Fact]
    public void CreateStateFrame_Created_HasCorrectFormat()
    {
        var sessionId = "stateid1";

        var frame = MuxProtocol.CreateStateFrame(sessionId, created: true);

        Assert.Equal(MuxProtocol.HeaderSize + 1, frame.Length);
        Assert.Equal(MuxProtocol.TypeSessionState, frame[0]);
        Assert.Equal(sessionId, Encoding.ASCII.GetString(frame, 1, 8));
        Assert.Equal(1, frame[MuxProtocol.HeaderSize]);
    }

    [Fact]
    public void CreateStateFrame_Destroyed_HasCorrectFormat()
    {
        var sessionId = "stateid2";

        var frame = MuxProtocol.CreateStateFrame(sessionId, created: false);

        Assert.Equal(0, frame[MuxProtocol.HeaderSize]);
    }

    [Fact]
    public void CreateClearScreenFrame_HasCorrectFormat()
    {
        var frame = MuxProtocol.CreateClearScreenFrame();

        Assert.Equal(MuxProtocol.HeaderSize, frame.Length);
        Assert.Equal(MuxProtocol.TypeResync, frame[0]);
        Assert.All(frame.Skip(1).Take(8), b => Assert.Equal(0, b));
    }

    [Fact]
    public void WriteSessionId_ShortId_PadsWithZeros()
    {
        var shortId = "abc";
        var data = Encoding.UTF8.GetBytes("test");

        var frame = MuxProtocol.CreateOutputFrame(shortId, 80, 24, data);

        var result = MuxProtocol.TryParseFrame(frame, out _, out var parsedId, out _);
        Assert.True(result);
        Assert.StartsWith("abc", parsedId);
        Assert.Equal(8, parsedId.Length);
    }

    [Fact]
    public void WriteSessionId_LongId_Truncates()
    {
        var longId = "abcdefghijklmnop";
        var data = Encoding.UTF8.GetBytes("test");

        var frame = MuxProtocol.CreateOutputFrame(longId, 80, 24, data);

        var result = MuxProtocol.TryParseFrame(frame, out _, out var parsedId, out _);
        Assert.True(result);
        Assert.Equal("abcdefgh", parsedId);
    }

}
