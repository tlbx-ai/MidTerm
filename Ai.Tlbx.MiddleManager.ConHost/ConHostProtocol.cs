using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ai.Tlbx.MiddleManager.ConHost;

/// <summary>
/// Binary IPC protocol between mm.exe and mm-con-host.
/// Format: [1 byte type][4 bytes length][payload]
/// </summary>
public static class ConHostProtocol
{
    public const int HeaderSize = 5;
    public const int MaxPayloadSize = 1024 * 1024;

    public static byte[] CreateInfoRequest()
    {
        return CreateFrame(ConHostMessageType.GetInfo, []);
    }

    public static byte[] CreateInfoResponse(SessionInfo info)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(info, ConHostJsonContext.Default.SessionInfo);
        return CreateFrame(ConHostMessageType.Info, json);
    }

    public static byte[] CreateInputMessage(ReadOnlySpan<byte> data)
    {
        return CreateFrame(ConHostMessageType.Input, data.ToArray());
    }

    public static byte[] CreateOutputMessage(int cols, int rows, ReadOnlySpan<byte> data)
    {
        // Output message payload: [cols:2][rows:2][data]
        var payload = new byte[4 + data.Length];
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(0, 2), (ushort)cols);
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(2, 2), (ushort)rows);
        data.CopyTo(payload.AsSpan(4));
        return CreateFrame(ConHostMessageType.Output, payload);
    }

    public static (int cols, int rows) ParseOutputDimensions(ReadOnlySpan<byte> payload)
    {
        if (payload.Length < 4)
        {
            return (0, 0);
        }
        var cols = BinaryPrimitives.ReadUInt16LittleEndian(payload.Slice(0, 2));
        var rows = BinaryPrimitives.ReadUInt16LittleEndian(payload.Slice(2, 2));
        return (cols, rows);
    }

    public static ReadOnlySpan<byte> GetOutputData(ReadOnlySpan<byte> payload)
    {
        return payload.Length >= 4 ? payload.Slice(4) : payload;
    }

    public static byte[] CreateResizeMessage(int cols, int rows)
    {
        var payload = new byte[8];
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(0, 4), cols);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(4, 4), rows);
        return CreateFrame(ConHostMessageType.Resize, payload);
    }

    public static byte[] CreateResizeAck()
    {
        return CreateFrame(ConHostMessageType.ResizeAck, []);
    }

    public static byte[] CreateStateChange(bool isRunning, int? exitCode)
    {
        var payload = new StateChangePayload { IsRunning = isRunning, ExitCode = exitCode };
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, ConHostJsonContext.Default.StateChangePayload);
        return CreateFrame(ConHostMessageType.StateChange, json);
    }

    public static byte[] CreateGetBuffer()
    {
        return CreateFrame(ConHostMessageType.GetBuffer, []);
    }

    public static byte[] CreateBufferResponse(ReadOnlySpan<byte> buffer)
    {
        return CreateFrame(ConHostMessageType.Buffer, buffer.ToArray());
    }

    public static byte[] CreateClose()
    {
        return CreateFrame(ConHostMessageType.Close, []);
    }

    public static byte[] CreateCloseAck()
    {
        return CreateFrame(ConHostMessageType.CloseAck, []);
    }

    public static byte[] CreateSetName(string? name)
    {
        var payload = Encoding.UTF8.GetBytes(name ?? string.Empty);
        return CreateFrame(ConHostMessageType.SetName, payload);
    }

    public static byte[] CreateSetNameAck()
    {
        return CreateFrame(ConHostMessageType.SetNameAck, []);
    }

    private static byte[] CreateFrame(ConHostMessageType type, byte[] payload)
    {
        var frame = new byte[HeaderSize + payload.Length];
        frame[0] = (byte)type;
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(1, 4), payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderSize));
        return frame;
    }

    public static bool TryReadHeader(ReadOnlySpan<byte> buffer, out ConHostMessageType type, out int payloadLength)
    {
        type = default;
        payloadLength = 0;

        if (buffer.Length < HeaderSize)
        {
            return false;
        }

        type = (ConHostMessageType)buffer[0];
        payloadLength = BinaryPrimitives.ReadInt32LittleEndian(buffer.Slice(1, 4));
        return true;
    }

    public static SessionInfo? ParseInfo(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, ConHostJsonContext.Default.SessionInfo);
    }

    public static StateChangePayload? ParseStateChange(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, ConHostJsonContext.Default.StateChangePayload);
    }

    public static (int cols, int rows) ParseResize(ReadOnlySpan<byte> payload)
    {
        var cols = BinaryPrimitives.ReadInt32LittleEndian(payload.Slice(0, 4));
        var rows = BinaryPrimitives.ReadInt32LittleEndian(payload.Slice(4, 4));
        return (cols, rows);
    }

    public static string ParseSetName(ReadOnlySpan<byte> payload)
    {
        return Encoding.UTF8.GetString(payload);
    }

    public static string GetPipeName(string sessionId)
    {
        return $"mm-con-{sessionId}";
    }
}

public enum ConHostMessageType : byte
{
    // Queries
    GetInfo = 0x01,
    Info = 0x02,
    GetBuffer = 0x03,
    Buffer = 0x04,

    // Terminal I/O
    Input = 0x10,
    Output = 0x11,

    // Control
    Resize = 0x20,
    ResizeAck = 0x21,
    SetName = 0x22,
    SetNameAck = 0x23,
    Close = 0x30,
    CloseAck = 0x31,

    // Events
    StateChange = 0x40
}

public sealed class SessionInfo
{
    public string Id { get; set; } = string.Empty;
    public int Pid { get; set; }
    public string ShellType { get; set; } = string.Empty;
    public int Cols { get; set; }
    public int Rows { get; set; }
    public bool IsRunning { get; set; }
    public int? ExitCode { get; set; }
    public string? CurrentWorkingDirectory { get; set; }
    public string? Name { get; set; }
    public DateTime CreatedAt { get; set; }
}

public sealed class StateChangePayload
{
    public bool IsRunning { get; set; }
    public int? ExitCode { get; set; }
}

[JsonSerializable(typeof(SessionInfo))]
[JsonSerializable(typeof(StateChangePayload))]
internal partial class ConHostJsonContext : JsonSerializerContext
{
}
