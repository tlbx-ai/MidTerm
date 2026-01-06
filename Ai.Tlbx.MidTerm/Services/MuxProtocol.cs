using System.Buffers;
using System.IO.Compression;

namespace Ai.Tlbx.MidTerm.Services
{
    /// <summary>
    /// Binary protocol for multiplexed WebSocket communication.
    /// Base frame format: [1 byte type][8 byte sessionId][payload]
    /// Output frame format: [1 byte type][8 byte sessionId][2 byte cols][2 byte rows][payload]
    /// SessionId is the first 8 chars of the session GUID (already 8 chars).
    /// </summary>
    public static class MuxProtocol
    {
        public const int HeaderSize = 9; // 1 byte type + 8 bytes sessionId
        public const int OutputHeaderSize = 13; // HeaderSize + 4 bytes (cols + rows)
        public const int MaxFrameSize = 64 * 1024;

        public const byte TypeTerminalOutput = 0x01;
        public const byte TypeTerminalInput = 0x02;
        public const byte TypeResize = 0x03;
        public const byte TypeSessionState = 0x04;
        public const byte TypeResync = 0x05; // Server -> Client: clear all terminals, buffer refresh follows
        public const byte TypeBufferRequest = 0x06; // Client -> Server: request buffer refresh for session
        public const byte TypeCompressedOutput = 0x07; // Server -> Client: GZip compressed terminal output

        // Compression settings
        public const int CompressionChunkSize = 256 * 1024; // Chunk large data before compressing
        public const int CompressionThreshold = 2048; // Only compress payloads > 2KB
        public const int CompressedOutputHeaderSize = 17; // HeaderSize + dims(4) + uncompressedLen(4)

        public static byte[] CreateOutputFrame(string sessionId, int cols, int rows, ReadOnlySpan<byte> data)
        {
            var frame = new byte[OutputHeaderSize + data.Length];
            frame[0] = TypeTerminalOutput;
            WriteSessionId(frame.AsSpan(1, 8), sessionId);
            BitConverter.TryWriteBytes(frame.AsSpan(9, 2), (ushort)cols);
            BitConverter.TryWriteBytes(frame.AsSpan(11, 2), (ushort)rows);
            data.CopyTo(frame.AsSpan(OutputHeaderSize));
            return frame;
        }

        /// <summary>
        /// Creates a GZip-compressed output frame.
        /// Format: [type:1][sessionId:8][cols:2][rows:2][uncompressedLen:4][gzip-data...]
        /// </summary>
        public static byte[] CreateCompressedOutputFrame(string sessionId, int cols, int rows, ReadOnlySpan<byte> data)
        {
            using var ms = new MemoryStream();

            // Write header (17 bytes)
            ms.WriteByte(TypeCompressedOutput);

            // SessionId (8 bytes)
            Span<byte> sessionIdBytes = stackalloc byte[8];
            WriteSessionId(sessionIdBytes, sessionId);
            ms.Write(sessionIdBytes);

            // Cols and rows (4 bytes)
            Span<byte> dimBytes = stackalloc byte[4];
            BitConverter.TryWriteBytes(dimBytes.Slice(0, 2), (ushort)cols);
            BitConverter.TryWriteBytes(dimBytes.Slice(2, 2), (ushort)rows);
            ms.Write(dimBytes);

            // Uncompressed length (4 bytes)
            Span<byte> lenBytes = stackalloc byte[4];
            BitConverter.TryWriteBytes(lenBytes, data.Length);
            ms.Write(lenBytes);

            // GZip compressed data
            using (var gzip = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
            {
                gzip.Write(data);
            }

            return ms.ToArray();
        }

        public static byte[] CreateStateFrame(string sessionId, bool created)
        {
            var frame = new byte[HeaderSize + 1];
            frame[0] = TypeSessionState;
            WriteSessionId(frame.AsSpan(1, 8), sessionId);
            frame[HeaderSize] = created ? (byte)1 : (byte)0;
            return frame;
        }

        /// <summary>
        /// Creates a resync frame that tells client to clear all terminals.
        /// Buffer refresh will follow immediately after.
        /// </summary>
        public static byte[] CreateClearScreenFrame()
        {
            var frame = new byte[HeaderSize];
            frame[0] = TypeResync;
            // Session ID is all zeros (applies to all sessions)
            return frame;
        }

        public static bool TryParseFrame(
            ReadOnlySpan<byte> data,
            out byte type,
            out string sessionId,
            out ReadOnlySpan<byte> payload)
        {
            type = 0;
            sessionId = string.Empty;
            payload = default;

            if (data.Length < HeaderSize)
            {
                return false;
            }

            type = data[0];
            sessionId = System.Text.Encoding.ASCII.GetString(data.Slice(1, 8));
            payload = data.Slice(HeaderSize);
            return true;
        }

        /// <summary>
        /// Parses dimensions from an output frame payload.
        /// Output frame payload starts with [cols:2][rows:2][data].
        /// </summary>
        public static (int cols, int rows) ParseOutputDimensions(ReadOnlySpan<byte> payload)
        {
            if (payload.Length < 4)
            {
                return (0, 0);
            }
            var cols = BitConverter.ToUInt16(payload.Slice(0, 2));
            var rows = BitConverter.ToUInt16(payload.Slice(2, 2));
            return (cols, rows);
        }

        /// <summary>
        /// Gets the data portion of an output frame payload (skipping the 4-byte dimension header).
        /// </summary>
        public static ReadOnlySpan<byte> GetOutputData(ReadOnlySpan<byte> payload)
        {
            return payload.Length >= 4 ? payload.Slice(4) : payload;
        }

        public static (int cols, int rows) ParseResizePayload(ReadOnlySpan<byte> payload)
        {
            if (payload.Length < 4)
            {
                return (80, 24);
            }
            var cols = BitConverter.ToUInt16(payload.Slice(0, 2));
            var rows = BitConverter.ToUInt16(payload.Slice(2, 2));
            return (cols, rows);
        }

        public static byte[] CreateResizePayload(int cols, int rows)
        {
            var payload = new byte[4];
            BitConverter.TryWriteBytes(payload.AsSpan(0, 2), (ushort)cols);
            BitConverter.TryWriteBytes(payload.AsSpan(2, 2), (ushort)rows);
            return payload;
        }

        private static void WriteSessionId(Span<byte> dest, string sessionId)
        {
            for (var i = 0; i < 8 && i < sessionId.Length; i++)
            {
                dest[i] = (byte)sessionId[i];
            }
        }
    }
}
