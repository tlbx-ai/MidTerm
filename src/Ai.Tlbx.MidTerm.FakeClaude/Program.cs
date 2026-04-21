using System.Globalization;
using System.Text.Json;

var prompt = (await Console.In.ReadToEndAsync().ConfigureAwait(false)).Trim();
var resumeSessionId = ReadOption(args, "--resume");
var sessionId = string.IsNullOrWhiteSpace(resumeSessionId)
    ? "claude-session-" + Guid.NewGuid().ToString("N")
    : resumeSessionId;
var dangerous = args.Contains("--dangerously-skip-permissions", StringComparer.Ordinal);
var model = ReadOption(args, "--model") ?? "claude-opus-test";
var effort = ReadOption(args, "--effort") ?? "medium";
var toolId = "tool-bash-1";
var envMarker = Environment.GetEnvironmentVariable("FAKE_CLAUDE_ENV") ?? string.Empty;

await WriteJsonAsync(new
{
    type = "system",
    subtype = "init",
    session_id = sessionId,
    model,
    permissionMode = dangerous ? "bypassPermissions" : "default"
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "stream_event",
    @event = new
    {
        type = "message_start",
        message = new
        {
            id = "msg-1",
            role = "assistant",
            model
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "stream_event",
    @event = new
    {
        type = "content_block_start",
        index = 0,
        content_block = new
        {
            type = "text"
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "stream_event",
    @event = new
    {
        type = "content_block_delta",
        index = 0,
        delta = new
        {
            type = "text_delta",
            text = "Claude is inspecting the workspace. "
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "stream_event",
    @event = new
    {
        type = "content_block_start",
        index = 1,
        content_block = new
        {
            type = "tool_use",
            id = toolId,
            name = "Bash",
            input = new { command = "pwd" }
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "stream_event",
    @event = new
    {
        type = "content_block_delta",
        index = 1,
        delta = new
        {
            type = "input_json_delta",
            partial_json = "{\"command\":\"pwd\"}"
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "user",
    session_id = sessionId,
    message = new
    {
        content = new object[]
        {
            new
            {
                type = "tool_result",
                tool_use_id = toolId,
                content = $"pwd -> {Environment.CurrentDirectory}"
            }
        }
    },
    tool_use_result = new
    {
        tool_use_id = toolId,
        stdout = Environment.CurrentDirectory,
        stderr = ""
    }
}).ConfigureAwait(false);

if (prompt.Contains("interrupt", StringComparison.OrdinalIgnoreCase))
{
    await Task.Delay(TimeSpan.FromSeconds(30)).ConfigureAwait(false);
    return;
}

var normalizedPrompt = string.Join(
    " ",
    prompt.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
var attachmentsCount = prompt.Contains("Attached resources", StringComparison.Ordinal) || prompt.Contains("Attached resource:", StringComparison.Ordinal)
    ? prompt.Split('\n').Count(static line => line.TrimStart().StartsWith("-", StringComparison.Ordinal))
    : 0;
var imageCount = prompt.Split('\n').Count(static line => line.Contains("[image]", StringComparison.Ordinal));

var assistantText =
    $"Fake Claude reply. resumed={(resumeSessionId is not null).ToString().ToLowerInvariant()} danger={dangerous.ToString().ToLowerInvariant()} effort={effort} env={envMarker} attachments={attachmentsCount.ToString(CultureInfo.InvariantCulture)} images={imageCount.ToString(CultureInfo.InvariantCulture)} prompt={normalizedPrompt}";

await WriteJsonAsync(new
{
    type = "stream_event",
    @event = new
    {
        type = "content_block_delta",
        index = 0,
        delta = new
        {
            type = "text_delta",
            text = assistantText
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "assistant",
    session_id = sessionId,
    message = new
    {
        content = new object[]
        {
            new
            {
                type = "text",
                text = assistantText
            }
        }
    }
}).ConfigureAwait(false);

await WriteJsonAsync(new
{
    type = "result",
    subtype = "success",
    session_id = sessionId,
    is_error = false,
    result = assistantText
}).ConfigureAwait(false);

static async Task WriteJsonAsync<T>(T payload)
{
    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload)).ConfigureAwait(false);
    await Console.Out.FlushAsync().ConfigureAwait(false);
}

static string? ReadOption(IReadOnlyList<string> args, string name)
{
    for (var i = 0; i < args.Count - 1; i++)
    {
        if (string.Equals(args[i], name, StringComparison.Ordinal))
        {
            return args[i + 1];
        }
    }

    return null;
}
