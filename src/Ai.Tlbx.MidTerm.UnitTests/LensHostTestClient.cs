using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.UnitTests;

internal static class LensHostTestClient
{
    public static async Task WriteCommandAsync(StreamWriter writer, LensHostCommandEnvelope command)
    {
        await writer.WriteLineAsync(JsonSerializer.Serialize(command, LensHostJsonContext.Default.LensHostCommandEnvelope));
        await writer.FlushAsync();
    }

    public static async Task<LensHostHello> ReadHelloAsync(StreamReader reader)
    {
        var line = await ReadLineWithTimeoutAsync(reader);
        return JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostHello)
               ?? throw new InvalidOperationException("Failed to deserialize Lens host hello.");
    }

    public static async Task<LensHostCommandResultEnvelope> ReadResultAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents,
        string? expectedCommandId = null)
    {
        while (true)
        {
            var message = await ReadMessageAsync(reader);
            if (message.Event is not null)
            {
                pendingEvents.Enqueue(message.Event);
                continue;
            }

            if (message.Result is null)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(expectedCommandId) ||
                string.Equals(message.Result.CommandId, expectedCommandId, StringComparison.Ordinal))
            {
                return message.Result;
            }
        }
    }

    public static async Task<LensHostEventEnvelope> ReadEventAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents)
    {
        if (pendingEvents.Count > 0)
        {
            return pendingEvents.Dequeue();
        }

        while (true)
        {
            var message = await ReadMessageAsync(reader);
            if (message.Event is not null)
            {
                return message.Event;
            }
        }
    }

    public static async Task<IReadOnlyList<LensHostEventEnvelope>> ReadUntilAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents,
        Func<LensHostEventEnvelope, bool> predicate,
        int maxEvents)
    {
        var events = new List<LensHostEventEnvelope>();
        while (events.Count < maxEvents)
        {
            var envelope = await ReadEventAsync(reader, pendingEvents);
            events.Add(envelope);
            if (predicate(envelope))
            {
                break;
            }
        }

        return events;
    }

    public static async Task<IReadOnlyList<LensHostEventEnvelope>> ReadEventsAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents,
        int count)
    {
        var events = new List<LensHostEventEnvelope>(count);
        while (events.Count < count)
        {
            events.Add(await ReadEventAsync(reader, pendingEvents));
        }

        return events;
    }

    private static async Task<LensHostMessage> ReadMessageAsync(StreamReader reader)
    {
        var line = await ReadLineWithTimeoutAsync(reader);
        using var json = JsonDocument.Parse(line);
        var root = json.RootElement;
        if (root.TryGetProperty("event", out _))
        {
            return new LensHostMessage
            {
                Event = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostEventEnvelope)
                        ?? throw new InvalidOperationException("Failed to deserialize Lens host event.")
            };
        }

        if (root.TryGetProperty("commandId", out _))
        {
            return new LensHostMessage
            {
                Result = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostCommandResultEnvelope)
                         ?? throw new InvalidOperationException("Failed to deserialize Lens host command result.")
            };
        }

        throw new InvalidOperationException("Unexpected Lens host message payload.");
    }

    private static async Task<string> ReadLineWithTimeoutAsync(StreamReader reader)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var line = await reader.ReadLineAsync(cts.Token).AsTask();
        return line ?? throw new EndOfStreamException("mtagenthost closed stdout unexpectedly.");
    }

    private sealed class LensHostMessage
    {
        public LensHostCommandResultEnvelope? Result { get; init; }

        public LensHostEventEnvelope? Event { get; init; }
    }
}
