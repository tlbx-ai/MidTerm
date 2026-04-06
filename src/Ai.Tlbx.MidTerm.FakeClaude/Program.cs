using System.Globalization;
using System.Text.Json;

const string FakeClaudeStateDirVariable = "MIDTERM_FAKE_CLAUDE_STATE_DIR";

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
var state = await LoadStateAsync(sessionId).ConfigureAwait(false);
var questionHarnessRequested =
    prompt.Contains("MIDTERM_CLAUDE_QA_TWO_PHASES", StringComparison.Ordinal) ||
    string.Equals(state.Mode, "qa-two-phases", StringComparison.Ordinal);

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
if (questionHarnessRequested)
{
    state.Mode = "qa-two-phases";
    state.Marker ??= ReadTaggedValue(prompt, "FINAL_MARKER=");
    if (!string.IsNullOrWhiteSpace(resumeSessionId))
    {
        state.AnswerPrompts.Add(normalizedPrompt);
    }

    if (state.Stage == 0)
    {
        state.Stage = 1;
        await SaveStateAsync(sessionId, state).ConfigureAwait(false);
        await EmitAssistantResponseAsync(
            sessionId,
            """
            <midterm-user-input>{"questions":[{"id":"language","header":"Language","question":"Which implementation language should I optimize for first?","multiSelect":false,"options":[{"label":"C#","description":"Bias toward backend and host changes."},{"label":"TypeScript","description":"Bias toward frontend and browser-facing changes."}]},{"id":"strictness","header":"Strictness","question":"How strict should I be about validation and guardrails?","multiSelect":false,"options":[{"label":"Strict","description":"Prefer explicit validation and defensive checks."},{"label":"Balanced","description":"Keep good validation without over-constraining the flow."}]}]}</midterm-user-input>
            """).ConfigureAwait(false);
        return;
    }

    if (state.Stage == 1)
    {
        state.Stage = 2;
        await SaveStateAsync(sessionId, state).ConfigureAwait(false);
        await EmitAssistantResponseAsync(
            sessionId,
            """
            <midterm-user-input>{"questions":[{"id":"output-style","header":"Output style","question":"How should I present the final answer?","multiSelect":false,"options":[{"label":"Concise","description":"Keep the final answer short and dense."},{"label":"Detailed","description":"Include more explanation and context."}]},{"id":"workspace-scan","header":"Workspace scan","question":"Should I inspect the workspace before answering?","multiSelect":false,"options":[{"label":"Yes","description":"Use tools to inspect the workspace when helpful."},{"label":"No","description":"Answer from the supplied context only."}]}]}</midterm-user-input>
            """).ConfigureAwait(false);
        return;
    }

    var finalMarker = state.Marker ?? "MISSING_MARKER";
    var answerSummary = string.Join(" || ", state.AnswerPrompts);
    await DeleteStateAsync(sessionId).ConfigureAwait(false);
    await EmitAssistantResponseAsync(
        sessionId,
        $"Fake Claude final. marker={finalMarker} answers={answerSummary} resumed={(resumeSessionId is not null).ToString().ToLowerInvariant()}").ConfigureAwait(false);
    return;
}

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

static async Task EmitAssistantResponseAsync(string sessionId, string assistantText)
{
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
}

static string? ReadTaggedValue(string text, string prefix)
{
    var index = text.IndexOf(prefix, StringComparison.Ordinal);
    if (index < 0)
    {
        return null;
    }

    var start = index + prefix.Length;
    var end = text.IndexOfAny([' ', '\r', '\n'], start);
    return end < 0 ? text[start..].Trim() : text[start..end].Trim();
}

static async Task<FakeClaudeState> LoadStateAsync(string sessionId)
{
    var path = GetStatePath(sessionId);
    if (!File.Exists(path))
    {
        return new FakeClaudeState();
    }

    await using var stream = File.OpenRead(path);
    return await JsonSerializer.DeserializeAsync<FakeClaudeState>(stream).ConfigureAwait(false) ?? new FakeClaudeState();
}

static async Task SaveStateAsync(string sessionId, FakeClaudeState state)
{
    var path = GetStatePath(sessionId);
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    await using var stream = File.Create(path);
    await JsonSerializer.SerializeAsync(stream, state).ConfigureAwait(false);
}

static Task DeleteStateAsync(string sessionId)
{
    var path = GetStatePath(sessionId);
    if (File.Exists(path))
    {
        File.Delete(path);
    }

    return Task.CompletedTask;
}

static string GetStatePath(string sessionId)
{
    var stateRoot = Environment.GetEnvironmentVariable(FakeClaudeStateDirVariable);
    if (string.IsNullOrWhiteSpace(stateRoot))
    {
        stateRoot = Path.Combine(Path.GetTempPath(), "midterm-fake-claude");
    }

    Directory.CreateDirectory(stateRoot);
    return Path.Combine(stateRoot, sessionId + ".json");
}

sealed class FakeClaudeState
{
    public string? Mode { get; set; }
    public int Stage { get; set; }
    public string? Marker { get; set; }
    public List<string> AnswerPrompts { get; set; } = [];
}
