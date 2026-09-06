using System.Collections.Concurrent;
using System.Net.WebSockets;
using Ai.Tlbx.MidTerm.Services.WebSockets;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class PrioritizedWebSocketWriterTests
{
    [Fact]
    public async Task Writer_PreservesSessionOrderAcrossFocusChangesAndRecoveryBarriers()
    {
        using var socket = new GateWebSocket();
        await using var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });
        var first = writer.SendAsync(new byte[] { 0 }, MuxWritePriority.Control).AsTask();
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));
        var old = writer.SendAsync(new byte[] { 1 }, MuxWritePriority.BackgroundLive, "session-a").AsTask();
        var active = writer.SendAsync(new byte[] { 2 }, MuxWritePriority.ActiveLive, "session-a").AsTask();
        var begin = writer.SendAsync(new byte[] { 3 }, MuxWritePriority.Control, "session-a").AsTask();
        var replay = writer.SendAsync(new byte[] { 4 }, MuxWritePriority.Recovery, "session-a").AsTask();
        var end = writer.SendAsync(new byte[] { 5 }, MuxWritePriority.Control, "session-a").AsTask();
        var peer = writer.SendAsync(new byte[] { 9 }, MuxWritePriority.ActiveLive, "session-b").AsTask();
        socket.ReleaseFirstSend();
        Assert.All(await Task.WhenAll(first, old, active, begin, replay, end, peer), Assert.True);
        Assert.Equal(new byte[] { 0, 9, 1, 2, 3, 4, 5 }, socket.CompletedFrames);
    }

    [Fact]
    public async Task Writer_GivesLowerPrioritySessionBoundedProgress()
    {
        using var socket = new GateWebSocket();
        await using var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });
        var sends = new List<Task<bool>> { writer.SendAsync(new byte[] { 0 }, MuxWritePriority.Control).AsTask() };
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));
        sends.Add(writer.SendAsync(new byte[] { 9 }, MuxWritePriority.BackgroundLive, "slow").AsTask());
        for (var i = 0; i < 100; i++)
            sends.Add(writer.SendAsync(new byte[] { 1 }, MuxWritePriority.ActiveLive, "active").AsTask());
        socket.ReleaseFirstSend();
        Assert.All(await Task.WhenAll(sends), Assert.True);
        Assert.InRange(Array.IndexOf(socket.CompletedFrames.ToArray(), (byte)9), 1, PrioritizedWebSocketWriter.PriorityBurstLimit + 1);
    }

    [Fact]
    public async Task Writer_FailedSendRejectsLaterWorkAndCompletesOwnedBuffersExactlyOnce()
    {
        using var socket = new GateWebSocket { FailSend = true };
        var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });
        var completed = new ConcurrentBag<bool>();
        var first = writer.SendAsync(new byte[] { 0 }, MuxWritePriority.Control).AsTask();
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));
        for (var i = 0; i < 20; i++)
            Assert.True(writer.TryQueueCopy(new byte[] { 1 }, MuxWritePriority.ActiveLive, completed.Add, "session"));
        socket.ReleaseFirstSend();
        Assert.False(await first);
#pragma warning disable IDISP016 // Exercise explicit shutdown and late enqueue after the failure path.
        await writer.DisposeAsync();
        Assert.Equal(20, completed.Count);
        Assert.All(completed, Assert.False);
        Assert.False(writer.TryQueueCopy(new byte[] { 2 }, MuxWritePriority.Control));
#pragma warning restore IDISP016
    }

    [Fact]
    public async Task Writer_SerializesFramesAndHonorsPriorityBetweenSends()
    {
        using var socket = new GateWebSocket();
        await using var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });

        var first = writer.SendAsync(new byte[] { 1 }, MuxWritePriority.BackgroundLive).AsTask();
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));
        var background = writer.SendAsync(new byte[] { 2 }, MuxWritePriority.BackgroundLive).AsTask();
        var recovery = writer.SendAsync(new byte[] { 3 }, MuxWritePriority.Recovery).AsTask();
        var control = writer.SendAsync(new byte[] { 4 }, MuxWritePriority.Control).AsTask();
        var active = writer.SendAsync(new byte[] { 5 }, MuxWritePriority.ActiveLive).AsTask();

        socket.ReleaseFirstSend();
        Assert.All(await Task.WhenAll(first, background, recovery, control, active), Assert.True);
        Assert.Equal(new byte[] { 1, 4, 5, 3, 2 }, socket.CompletedFrames);
    }

    [Fact]
    public async Task Writer_BoundsPendingFramesAndCompletesThemOnDispose()
    {
        using var socket = new GateWebSocket();
        var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });
        var sends = new List<Task<bool>>
        {
            writer.SendAsync(new byte[] { 1 }, MuxWritePriority.BackgroundLive).AsTask()
        };
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));

        for (var i = 0; i < PrioritizedWebSocketWriter.MaxQueuedFrames; i++)
        {
            sends.Add(writer.SendAsync(new byte[] { 2 }, MuxWritePriority.BackgroundLive).AsTask());
        }
        Assert.False(await writer.SendAsync(new byte[] { 3 }, MuxWritePriority.Control));

        await writer.DisposeAsync();
        Assert.All(await Task.WhenAll(sends), Assert.False);
    }

    [Fact]
    public async Task Writer_BoundsRetainedPayloadBytes()
    {
        using var socket = new GateWebSocket();
        var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });
        var first = writer.SendAsync(new byte[] { 1 }, MuxWritePriority.BackgroundLive).AsTask();
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));

        var frame = new byte[64 * 1024];
        var accepted = new List<Task<bool>>();
        while (true)
        {
            var send = writer.SendAsync(frame, MuxWritePriority.BackgroundLive).AsTask();
            if (send.IsCompletedSuccessfully && !await send)
            {
                break;
            }
            accepted.Add(send);
        }

        Assert.Equal(PrioritizedWebSocketWriter.MaxQueuedBytes / frame.Length, accepted.Count);
        await writer.DisposeAsync();
        Assert.False(await first);
        Assert.All(await Task.WhenAll(accepted), Assert.False);
    }

    [Fact]
    public async Task TryQueueCopy_TransfersPayloadOwnershipWithoutWaitingForPhysicalSend()
    {
        using var socket = new GateWebSocket();
        await using var writer = new PrioritizedWebSocketWriter(socket, static (_, _) => { });
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var payload = new byte[] { 7, 8, 9 };

        Assert.True(writer.TryQueueCopy(
            payload,
            MuxWritePriority.ActiveLive,
            succeeded => completion.TrySetResult(succeeded)));
        await socket.FirstSendStarted.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(completion.Task.IsCompleted);

        payload[0] = 99;
        socket.ReleaseFirstSend();
        Assert.True(await completion.Task.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(new byte[] { 7 }, socket.CompletedFrames);
    }

    private sealed class GateWebSocket : WebSocket
    {
        public bool FailSend { get; init; }
        private readonly TaskCompletionSource _firstSendStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _releaseFirstSend = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _sendCount;

        public Task FirstSendStarted => _firstSendStarted.Task;
        public ConcurrentQueue<byte> CompletedFrames { get; } = new();
        public override WebSocketCloseStatus? CloseStatus => null;
        public override string? CloseStatusDescription => null;
        public override WebSocketState State => WebSocketState.Open;
        public override string? SubProtocol => null;

        public void ReleaseFirstSend() => _releaseFirstSend.TrySetResult();
        public override void Abort() { }
        public override Task CloseAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override Task CloseOutputAsync(WebSocketCloseStatus closeStatus, string? statusDescription, CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Dispose() { }
        public override Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancellationToken) => throw new NotSupportedException();

        public override async Task SendAsync(
            ArraySegment<byte> buffer,
            WebSocketMessageType messageType,
            bool endOfMessage,
            CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _sendCount) == 1)
            {
                _firstSendStarted.TrySetResult();
                await _releaseFirstSend.Task.WaitAsync(cancellationToken);
            }
            if (FailSend) throw new WebSocketException();
            CompletedFrames.Enqueue(buffer[0]);
        }
    }
}
