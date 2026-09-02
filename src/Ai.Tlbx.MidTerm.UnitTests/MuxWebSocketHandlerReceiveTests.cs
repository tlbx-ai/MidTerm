using System.Net.WebSockets;
using Ai.Tlbx.MidTerm.Services.WebSockets;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class MuxWebSocketHandlerReceiveTests
{
    [Fact]
    public async Task ReceiveMuxMessageAsync_ReassemblesTransportFragments()
    {
        using var socket = new FragmentedWebSocket(
            new Fragment([0x02, 0x01, 0x02], EndOfMessage: false),
            new Fragment([0x03, 0x04], EndOfMessage: true));
        var buffer = new byte[16];

        var result = await MuxWebSocketHandler.ReceiveMuxMessageAsync(
            socket,
            buffer,
            CancellationToken.None);

        Assert.False(result.TooLarge);
        Assert.Equal(WebSocketMessageType.Binary, result.MessageType);
        Assert.Equal(5, result.Count);
        Assert.Equal([0x02, 0x01, 0x02, 0x03, 0x04], buffer[..result.Count]);
    }

    [Fact]
    public async Task ReceiveMuxMessageAsync_RejectsAFragmentedFrameBeyondTheBoundedBuffer()
    {
        using var socket = new FragmentedWebSocket(
            new Fragment([0x01, 0x02, 0x03, 0x04], EndOfMessage: false));
        var buffer = new byte[4];

        var result = await MuxWebSocketHandler.ReceiveMuxMessageAsync(
            socket,
            buffer,
            CancellationToken.None);

        Assert.True(result.TooLarge);
        Assert.Equal(4, result.Count);
    }

    private readonly record struct Fragment(byte[] Data, bool EndOfMessage);

    private sealed class FragmentedWebSocket(params Fragment[] fragments) : WebSocket
    {
        private readonly Queue<Fragment> _fragments = new(fragments);

        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;

        public override void Abort()
        {
        }

        public override Task CloseAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken) => Task.CompletedTask;

        public override Task CloseOutputAsync(
            WebSocketCloseStatus closeStatus,
            string? statusDescription,
            CancellationToken cancellationToken) => Task.CompletedTask;

        public override void Dispose()
        {
        }

        public override Task<WebSocketReceiveResult> ReceiveAsync(
            ArraySegment<byte> buffer,
            CancellationToken cancellationToken)
        {
            var fragment = _fragments.Dequeue();
            fragment.Data.CopyTo(buffer.AsSpan());
            return Task.FromResult(new WebSocketReceiveResult(
                fragment.Data.Length,
                WebSocketMessageType.Binary,
                fragment.EndOfMessage));
        }

        public override Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
