using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Common.Logging;
using Ai.Tlbx.MidTerm.Common.Process;

namespace Ai.Tlbx.MidTerm.Common.Protocol;

/// <summary>
/// Binary IPC protocol between mm and mmttyhost.
/// Format: [1 byte type][4 bytes length][payload]
/// </summary>
public static class TtyHostProtocol
{
    public const int HeaderSize = 5;
    public const int MaxPayloadSize = 1024 * 1024;

    public static byte[] CreateInfoRequest()
    {
        return CreateFrame(TtyHostMessageType.GetInfo, []);
    }

    public static byte[] CreateInfoResponse(SessionInfo info)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(info, TtyHostJsonContext.Default.SessionInfo);
        return CreateFrame(TtyHostMessageType.Info, json);
    }

    public static byte[] CreateInputMessage(ReadOnlySpan<byte> data)
    {
        return CreateFrame(TtyHostMessageType.Input, data.ToArray());
    }

    public static byte[] CreateOutputMessage(int cols, int rows, ReadOnlySpan<byte> data)
    {
        var payload = new byte[4 + data.Length];
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(0, 2), (ushort)cols);
        BinaryPrimitives.WriteUInt16LittleEndian(payload.AsSpan(2, 2), (ushort)rows);
        data.CopyTo(payload.AsSpan(4));
        return CreateFrame(TtyHostMessageType.Output, payload);
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
        return CreateFrame(TtyHostMessageType.Resize, payload);
    }

    public static byte[] CreateResizeAck()
    {
        return CreateFrame(TtyHostMessageType.ResizeAck, []);
    }

    public static byte[] CreateStateChange(bool isRunning, int? exitCode)
    {
        var payload = new StateChangePayload { IsRunning = isRunning, ExitCode = exitCode };
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, TtyHostJsonContext.Default.StateChangePayload);
        return CreateFrame(TtyHostMessageType.StateChange, json);
    }

    public static byte[] CreateGetBuffer()
    {
        return CreateFrame(TtyHostMessageType.GetBuffer, []);
    }

    public static byte[] CreateBufferResponse(ReadOnlySpan<byte> buffer)
    {
        return CreateFrame(TtyHostMessageType.Buffer, buffer.ToArray());
    }

    public static byte[] CreateClose()
    {
        return CreateFrame(TtyHostMessageType.Close, []);
    }

    public static byte[] CreateCloseAck()
    {
        return CreateFrame(TtyHostMessageType.CloseAck, []);
    }

    public static byte[] CreateSetName(string? name)
    {
        var payload = Encoding.UTF8.GetBytes(name ?? string.Empty);
        return CreateFrame(TtyHostMessageType.SetName, payload);
    }

    public static byte[] CreateSetNameAck()
    {
        return CreateFrame(TtyHostMessageType.SetNameAck, []);
    }

    private static byte[] CreateFrame(TtyHostMessageType type, byte[] payload)
    {
        var frame = new byte[HeaderSize + payload.Length];
        frame[0] = (byte)type;
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(1, 4), payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderSize));
        return frame;
    }

    public static bool TryReadHeader(ReadOnlySpan<byte> buffer, out TtyHostMessageType type, out int payloadLength)
    {
        type = default;
        payloadLength = 0;

        if (buffer.Length < HeaderSize)
        {
            return false;
        }

        type = (TtyHostMessageType)buffer[0];
        payloadLength = BinaryPrimitives.ReadInt32LittleEndian(buffer.Slice(1, 4));
        return true;
    }

    public static SessionInfo? ParseInfo(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, TtyHostJsonContext.Default.SessionInfo);
    }

    public static StateChangePayload? ParseStateChange(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, TtyHostJsonContext.Default.StateChangePayload);
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

    public static byte[] CreateProcessEvent(ProcessEventPayload payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, TtyHostJsonContext.Default.ProcessEventPayload);
        return CreateFrame(TtyHostMessageType.ProcessEvent, json);
    }

    public static ProcessEventPayload? ParseProcessEvent(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, TtyHostJsonContext.Default.ProcessEventPayload);
    }

    public static byte[] CreateForegroundChange(ForegroundChangePayload payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, TtyHostJsonContext.Default.ForegroundChangePayload);
        return CreateFrame(TtyHostMessageType.ForegroundChange, json);
    }

    public static ForegroundChangePayload? ParseForegroundChange(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, TtyHostJsonContext.Default.ForegroundChangePayload);
    }

    public static byte[] CreateProcessSnapshot(ProcessSnapshotPayload payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, TtyHostJsonContext.Default.ProcessSnapshotPayload);
        return CreateFrame(TtyHostMessageType.ProcessSnapshot, json);
    }

    public static ProcessSnapshotPayload? ParseProcessSnapshot(ReadOnlySpan<byte> payload)
    {
        return JsonSerializer.Deserialize(payload, TtyHostJsonContext.Default.ProcessSnapshotPayload);
    }

    public static byte[] CreateSetLogLevelMessage(LogSeverity level)
    {
        var payload = new byte[1] { (byte)level };
        return CreateFrame(TtyHostMessageType.SetLogLevel, payload);
    }

    public static byte[] CreateSetLogLevelAck()
    {
        return CreateFrame(TtyHostMessageType.SetLogLevelAck, []);
    }

    public static LogSeverity ParseSetLogLevel(ReadOnlySpan<byte> payload)
    {
        return payload.Length > 0 ? (LogSeverity)payload[0] : LogSeverity.Warn;
    }
}

/// <summary>
/// Message types for the TtyHost IPC protocol.
/// </summary>
public enum TtyHostMessageType : byte
{
    GetInfo = 0x01,
    Info = 0x02,
    GetBuffer = 0x03,
    Buffer = 0x04,

    Input = 0x10,
    Output = 0x11,

    Resize = 0x20,
    ResizeAck = 0x21,
    SetName = 0x22,
    SetNameAck = 0x23,
    Close = 0x30,
    CloseAck = 0x31,

    StateChange = 0x40,

    // Process monitoring
    ProcessEvent = 0x50,
    ForegroundChange = 0x51,
    ProcessSnapshot = 0x52,

    // Settings updates
    SetLogLevel = 0x60,
    SetLogLevelAck = 0x61
}

/// <summary>
/// Session metadata exchanged between mt and mthost.
/// </summary>
public sealed class SessionInfo
{
    public string Id { get; set; } = string.Empty;
    public int Pid { get; set; }
    public int HostPid { get; set; }  // mthost process ID (for orphan detection)
    public string ShellType { get; set; } = string.Empty;
    public int Cols { get; set; }
    public int Rows { get; set; }
    public bool IsRunning { get; set; }
    public int? ExitCode { get; set; }
    public string? Name { get; set; }
    public string? TerminalTitle { get; set; }
    public bool ManuallyNamed { get; set; }
    public DateTime CreatedAt { get; set; }
    public string? TtyHostVersion { get; set; }

    // Process monitoring fields
    public string? CurrentDirectory { get; set; }
    public int? ForegroundPid { get; set; }
    public string? ForegroundName { get; set; }
    public string? ForegroundCommandLine { get; set; }
}

/// <summary>
/// Payload for session state change notifications.
/// </summary>
public sealed class StateChangePayload
{
    public bool IsRunning { get; set; }
    public int? ExitCode { get; set; }
}

/// <summary>
/// Payload for process lifecycle events (fork/exec/exit).
/// </summary>
public sealed class ProcessEventPayload
{
    public ProcessEventType Type { get; set; }
    public int Pid { get; set; }
    public int ParentPid { get; set; }
    public string? Name { get; set; }
    public string? CommandLine { get; set; }
    public int? ExitCode { get; set; }
    public DateTime Timestamp { get; set; }
}

/// <summary>
/// Payload for foreground process change notifications.
/// </summary>
public sealed class ForegroundChangePayload
{
    public int Pid { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? CommandLine { get; set; }
    public string? Cwd { get; set; }
}

/// <summary>
/// Payload for process tree snapshot.
/// </summary>
public sealed class ProcessSnapshotPayload
{
    public int ShellPid { get; set; }
    public string? ShellCwd { get; set; }
    public ForegroundChangePayload? Foreground { get; set; }
    public List<ProcessInfoPayload> Processes { get; set; } = [];
}

/// <summary>
/// Basic process info in a snapshot.
/// </summary>
public sealed class ProcessInfoPayload
{
    public int Pid { get; set; }
    public int ParentPid { get; set; }
    public string Name { get; set; } = string.Empty;
    public string? CommandLine { get; set; }
    public string? Cwd { get; set; }
}

[JsonSerializable(typeof(SessionInfo))]
[JsonSerializable(typeof(StateChangePayload))]
[JsonSerializable(typeof(ProcessEventType))]
[JsonSerializable(typeof(ProcessEventPayload))]
[JsonSerializable(typeof(ForegroundChangePayload))]
[JsonSerializable(typeof(ProcessSnapshotPayload))]
[JsonSerializable(typeof(ProcessInfoPayload))]
[JsonSerializable(typeof(List<ProcessInfoPayload>))]
public partial class TtyHostJsonContext : JsonSerializerContext
{
}
