using System.Globalization;
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
        return await ReadEventAsync(reader, pendingEvents, TimeSpan.FromSeconds(30));
    }

    public static async Task<LensHostEventEnvelope> ReadEventAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents,
        TimeSpan timeout)
    {
        if (pendingEvents.Count > 0)
        {
            return pendingEvents.Dequeue();
        }

        while (true)
        {
            var message = await ReadMessageAsync(reader, timeout);
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

    public static async Task<IReadOnlyList<LensHostEventEnvelope>> ReadUntilMatchAsync(
        StreamReader reader,
        Queue<LensHostEventEnvelope> pendingEvents,
        Func<LensHostEventEnvelope, bool> predicate,
        int maxEvents = 64,
        TimeSpan? timeout = null)
    {
        var events = new List<LensHostEventEnvelope>();
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));

        while (events.Count < maxEvents)
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            var envelope = await ReadEventAsync(reader, pendingEvents, remaining);
            events.Add(envelope);
            if (predicate(envelope))
            {
                return events;
            }
        }

        throw new TimeoutException(
            $"Timed out waiting for a matching Lens host event. Saw {events.Count} event(s): {string.Join(", ", events.Select(static envelope => envelope.Event.Type))}");
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

    private static async Task<LensHostMessage> ReadMessageAsync(StreamReader reader, TimeSpan? timeout = null)
    {
        var line = await ReadLineWithTimeoutAsync(reader, timeout);
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

    private static async Task<string> ReadLineWithTimeoutAsync(StreamReader reader, TimeSpan? timeout = null)
    {
        var readTask = reader.ReadLineAsync();
        var effectiveTimeout = timeout ?? TimeSpan.FromSeconds(30);
        var completed = await Task.WhenAny(readTask, Task.Delay(effectiveTimeout));
        if (!ReferenceEquals(completed, readTask))
        {
            var secondsText = effectiveTimeout.TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture);
            throw new TimeoutException($"Timed out waiting {secondsText}s for mtagenthost stdout.");
        }

        var line = await readTask;
        return line ?? throw new EndOfStreamException("mtagenthost closed stdout unexpectedly.");
    }

    private sealed class LensHostMessage
    {
        public LensHostCommandResultEnvelope? Result { get; init; }

        public LensHostEventEnvelope? Event { get; init; }
    }
}
