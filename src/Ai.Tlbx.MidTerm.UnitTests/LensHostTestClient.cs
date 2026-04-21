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
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        string? expectedCommandId = null)
    {
        while (true)
        {
            var message = await ReadMessageAsync(reader);
            if (message.Patch is not null)
            {
                pendingPatches.Enqueue(message.Patch);
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

    public static async Task<LensHostHistoryPatchEnvelope> ReadPatchAsync(
        StreamReader reader,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches)
    {
        return await ReadPatchAsync(reader, pendingPatches, TimeSpan.FromSeconds(30));
    }

    public static async Task<LensHostHistoryPatchEnvelope> ReadPatchAsync(
        StreamReader reader,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        TimeSpan timeout)
    {
        if (pendingPatches.Count > 0)
        {
            return pendingPatches.Dequeue();
        }

        while (true)
        {
            var message = await ReadMessageAsync(reader, timeout);
            if (message.Patch is not null)
            {
                return message.Patch;
            }
        }
    }

    public static async Task<IReadOnlyList<LensHostHistoryPatchEnvelope>> ReadUntilAsync(
        StreamReader reader,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        Func<LensHostHistoryPatchEnvelope, bool> predicate,
        int maxPatches)
    {
        var patches = new List<LensHostHistoryPatchEnvelope>();
        while (patches.Count < maxPatches)
        {
            var envelope = await ReadPatchAsync(reader, pendingPatches);
            patches.Add(envelope);
            if (predicate(envelope))
            {
                break;
            }
        }

        return patches;
    }

    public static async Task<IReadOnlyList<LensHostHistoryPatchEnvelope>> ReadUntilMatchAsync(
        StreamReader reader,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        Func<LensHostHistoryPatchEnvelope, bool> predicate,
        int maxPatches = 64,
        TimeSpan? timeout = null)
    {
        var patches = new List<LensHostHistoryPatchEnvelope>();
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));

        while (patches.Count < maxPatches)
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            var envelope = await ReadPatchAsync(reader, pendingPatches, remaining);
            patches.Add(envelope);
            if (predicate(envelope))
            {
                return patches;
            }
        }

        throw new TimeoutException(
            $"Timed out waiting for a matching Lens host patch. Saw {patches.Count} patch(es): {string.Join(", ", patches.Select(static envelope => envelope.Patch.CurrentTurn.State))}");
    }

    public static async Task<IReadOnlyList<LensHostHistoryPatchEnvelope>> ReadPatchesAsync(
        StreamReader reader,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        int count)
    {
        var patches = new List<LensHostHistoryPatchEnvelope>(count);
        while (patches.Count < count)
        {
            patches.Add(await ReadPatchAsync(reader, pendingPatches));
        }

        return patches;
    }

    public static async Task<LensHistoryWindowResponse> GetHistoryWindowAsync(
        StreamReader reader,
        StreamWriter writer,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        string sessionId,
        int? startIndex = null,
        int? count = null,
        int? viewportWidth = null,
        string? commandId = null)
    {
        var requestCommandId = string.IsNullOrWhiteSpace(commandId)
            ? $"cmd-history-{Guid.NewGuid():N}"
            : commandId;

        await WriteCommandAsync(writer, new LensHostCommandEnvelope
        {
            CommandId = requestCommandId,
            SessionId = sessionId,
            Type = "history.window.get",
            HistoryWindow = new LensHostHistoryWindowRequest
            {
                StartIndex = startIndex,
                Count = count,
                ViewportWidth = viewportWidth
            }
        });

        var result = await ReadResultAsync(reader, pendingPatches, requestCommandId);
        return result.HistoryWindow
               ?? throw new InvalidOperationException("mtagenthost did not return a history window.");
    }

    public static async Task<LensHistoryWindowResponse> WaitForHistoryWindowAsync(
        StreamReader reader,
        StreamWriter writer,
        Queue<LensHostHistoryPatchEnvelope> pendingPatches,
        string sessionId,
        Func<LensHistoryWindowResponse, bool> predicate,
        TimeSpan timeout,
        int? count = null)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var window = await GetHistoryWindowAsync(reader, writer, pendingPatches, sessionId, count: count);
            if (predicate(window))
            {
                return window;
            }

            await Task.Delay(100);
        }

        throw new TimeoutException($"Timed out waiting for a matching history window for Lens session '{sessionId}'.");
    }

    public static string CollectAssistantText(LensHistoryWindowResponse window)
    {
        var completedAssistantMessages = window.History
            .Where(static item =>
                string.Equals(item.ItemType, "assistant_message", StringComparison.Ordinal) &&
                !string.IsNullOrWhiteSpace(item.Body))
            .Select(static item => item.Body)
            .ToList();

        if (completedAssistantMessages.Count > 0)
        {
            return string.Join(Environment.NewLine, completedAssistantMessages);
        }

        return window.Streams.AssistantText;
    }

    private static async Task<LensHostMessage> ReadMessageAsync(StreamReader reader, TimeSpan? timeout = null)
    {
        var line = await ReadLineWithTimeoutAsync(reader, timeout);
        using var json = JsonDocument.Parse(line);
        var root = json.RootElement;
        if (root.TryGetProperty("patch", out _))
        {
            return new LensHostMessage
            {
                Patch = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostHistoryPatchEnvelope)
                        ?? throw new InvalidOperationException("Failed to deserialize Lens host history patch.")
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

        public LensHostHistoryPatchEnvelope? Patch { get; init; }
    }
}
