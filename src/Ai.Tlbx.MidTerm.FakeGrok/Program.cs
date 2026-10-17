using System.Globalization;
using System.Text.Json;

var sessionId = "grok-session-" + Guid.NewGuid().ToString("N");
var activePromptId = string.Empty;
var activeQuestionId = string.Empty;
var cancelRequested = false;
var capturePath = Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_CAPTURE_PATH");
var protocolVersion = int.TryParse(
    Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_PROTOCOL_VERSION"),
    NumberStyles.Integer,
    CultureInfo.InvariantCulture,
    out var configuredProtocolVersion)
    ? configuredProtocolVersion
    : 1;
PersistLaunchCapture(capturePath, CreateLaunchCapture());

while (await Console.In.ReadLineAsync().ConfigureAwait(false) is { } rawLine)
{
    if (string.IsNullOrWhiteSpace(rawLine))
    {
        continue;
    }

    using var document = JsonDocument.Parse(rawLine);
    var root = document.RootElement;
    var method = GetString(root, "method");
    var id = root.TryGetProperty("id", out var idElement) ? idElement.Clone() : default;

    if (method is null && id.ValueKind != JsonValueKind.Undefined)
    {
        if (id.ToString() == activeQuestionId && !string.IsNullOrWhiteSpace(activePromptId))
        {
            await WriteNotificationAsync("session/update", new
            {
                sessionId,
                update = new
                {
                    sessionUpdate = "agent_message_chunk",
                    content = new { type = "text", text = root.GetRawText() }
                }
            }).ConfigureAwait(false);
            await WriteResponseAsync(JsonSerializer.SerializeToElement(activePromptId), new
            {
                stopReason = cancelRequested ? "cancelled" : "end_turn"
            }).ConfigureAwait(false);
            activePromptId = string.Empty;
            activeQuestionId = string.Empty;
            cancelRequested = false;
        }
        continue;
    }

    switch (method)
    {
        case "initialize":
            await WriteResponseAsync(id, new
            {
                protocolVersion,
                agentCapabilities = new
                {
                    loadSession = true,
                    promptCapabilities = new
                    {
                        image = true,
                        audio = false,
                        embeddedContext = true
                    },
                    mcpCapabilities = new
                    {
                        http = true,
                        sse = true
                    }
                },
                authMethods = Array.Empty<object>(),
                _meta = new
                {
                    agentVersion = "fake-grok",
                    modelState = BuildModelState()
                }
            }).ConfigureAwait(false);
            break;
        case "session/new":
            await WriteResponseAsync(id, new
            {
                sessionId,
                models = BuildModelState()
            }).ConfigureAwait(false);
            await WriteNotificationAsync("_x.ai/session/setup", new { sessionId, phase = "ready" }).ConfigureAwait(false);
            await WriteAvailableCommandsUpdateAsync(sessionId).ConfigureAwait(false);
            break;
        case "session/prompt":
            activePromptId = id.ToString();
            var text = ReadPromptText(root);
            var imageSummary = ReadPromptImageSummary(root);
            if (text.StartsWith("question-test", StringComparison.Ordinal))
            {
                activeQuestionId = "grok-question-1";
                var questionMethod = text.Contains("legacy", StringComparison.Ordinal) ? "x.ai/ask_user_question" : "_x.ai/ask_user_question";
                var questionParameters = new
                {
                    sessionId,
                    toolCallId = "question-tool-1",
                    questions = new object[]
                    {
                        new { id = "color", question = "Which color?", options = new[] { new { label = "Blue", description = "Blue color", preview = "#0000ff" }, new { label = "Red", description = "Red color", preview = "#ff0000" } } },
                        new { question = "Which checks?", multiSelect = true, options = new[] { new { label = "Tests", preview = "not-for-multi" }, new { label = "Docs", preview = "not-for-multi" } } },
                        new { id = "notes", question = "Anything else?", options = Array.Empty<object>() }
                    },
                    mode = "default"
                };
                await WriteRequestAsync(activeQuestionId, questionMethod,
                    text.Contains("wrapped", StringComparison.Ordinal)
                        ? new { method = questionMethod, @params = questionParameters }
                        : (object)questionParameters).ConfigureAwait(false);
                break;
            }
            await WriteAvailableCommandsUpdateAsync(sessionId).ConfigureAwait(false);
            await WriteNotificationAsync("session/update", new
            {
                sessionId,
                update = new
                {
                    sessionUpdate = "usage_update",
                    used = 1234,
                    size = 128000,
                    cost = new { amount = 0.0123, currency = "USD" }
                }
            }).ConfigureAwait(false);
            await WriteNotificationAsync("_x.ai/session_notification", new
            {
                sessionId,
                notification = new
                {
                    title = "Fake Grok notification",
                    message = "Session notification handled."
                }
            }).ConfigureAwait(false);
            await WriteNotificationAsync("session/update", new
            {
                sessionId,
                update = new
                {
                    sessionUpdate = "agent_thought_chunk",
                    content = new
                    {
                        type = "text",
                        text = "Fake Grok is thinking. "
                    }
                }
            }).ConfigureAwait(false);
            await WriteNotificationAsync("session/update", new
            {
                sessionId,
                update = new
                {
                    sessionUpdate = "tool_call",
                    toolCallId = "grok-tool-1",
                    title = "Inspect workspace",
                    kind = "read",
                    status = "pending"
                }
            }).ConfigureAwait(false);
            await WriteNotificationAsync("session/update", new
            {
                sessionId,
                update = new
                {
                    sessionUpdate = "tool_call_update",
                    toolCallId = "grok-tool-1",
                    status = "completed",
                    content = new object[]
                    {
                        new
                        {
                            type = "content",
                            content = new
                            {
                                type = "text",
                                text = "Workspace inspected."
                            }
                        }
                    }
                }
            }).ConfigureAwait(false);

            if (text.Contains("permission", StringComparison.OrdinalIgnoreCase))
            {
                await WriteRequestAsync("grok-permission-1", "session/request_permission", new
                {
                    sessionId,
                    toolCall = new
                    {
                        toolCallId = "grok-tool-2",
                        title = "Run a command"
                    },
                    options = new[]
                    {
                        new { optionId = "allow-once", name = "Allow once", kind = "allow_once" },
                        new { optionId = "reject-once", name = "Reject", kind = "reject_once" }
                    }
                }).ConfigureAwait(false);
            }

            if (text.Contains("interrupt", StringComparison.OrdinalIgnoreCase))
            {
                break;
            }

            await WriteNotificationAsync("session/update", new
            {
                sessionId,
                update = new
                {
                    sessionUpdate = "agent_message_chunk",
                    content = new
                    {
                        type = "text",
                        text = "Fake Grok reply. prompt=" + text + imageSummary
                    }
                }
            }).ConfigureAwait(false);
            await WriteResponseAsync(id, new
            {
                stopReason = "end_turn"
            }).ConfigureAwait(false);
            activePromptId = string.Empty;
            break;
        case "session/cancel":
            if (!string.IsNullOrWhiteSpace(activeQuestionId))
            {
                cancelRequested = true;
                break;
            }
            if (!string.IsNullOrWhiteSpace(activePromptId))
            {
                await WriteNotificationAsync("session/update", new
                {
                    sessionId,
                    update = new
                    {
                        sessionUpdate = "agent_message_chunk",
                        content = new { type = "text", text = "Final update before cancellation settled." }
                    }
                }).ConfigureAwait(false);
                await WriteResponseAsync(JsonDocument.Parse($"\"{activePromptId}\"").RootElement.Clone(), new
                {
                    stopReason = "cancelled"
                }).ConfigureAwait(false);
                activePromptId = string.Empty;
            }

            break;
        default:
            if (id.ValueKind != JsonValueKind.Undefined)
            {
                await WriteJsonAsync(new
                {
                    jsonrpc = "2.0",
                    id,
                    error = new
                    {
                        code = -32601,
                        message = "Unsupported fake Grok method."
                    }
                }).ConfigureAwait(false);
            }

            break;
    }
}

static object BuildModelState()
{
    return new
    {
        currentModelId = "grok-build-0.1",
        availableModels = new[]
        {
            new { modelId = "grok-build-0.1", name = "grok-build-0.1" },
            new { modelId = "grok-4.3", name = "grok-4.3" }
        }
    };
}

static async Task WriteAvailableCommandsUpdateAsync(string sessionId)
{
    await WriteNotificationAsync("session/update", new
    {
        sessionId,
        update = new
        {
            sessionUpdate = "available_commands_update",
            availableCommands = new object[]
            {
                new
                {
                    name = "compact",
                    description = "Compress conversation history to save context window",
                    input = new { hint = "optional context about what to preserve" }
                },
                new
                {
                    name = "always-approve",
                    description = "Toggle always-approve mode",
                    input = new { hint = "on|off" }
                }
            },
            _meta = new
            {
                tools = new[]
                {
                    "run_terminal_command",
                    "read_file"
                }
            }
        }
    }).ConfigureAwait(false);
}

static string ReadPromptText(JsonElement root)
{
    if (!root.TryGetProperty("params", out var parameters) ||
        !parameters.TryGetProperty("prompt", out var prompt) ||
        prompt.ValueKind != JsonValueKind.Array)
    {
        return string.Empty;
    }

    var parts = new List<string>();
    foreach (var block in prompt.EnumerateArray())
    {
        if (block.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String)
        {
            parts.Add(text.GetString() ?? string.Empty);
        }
    }

    return string.Join(" ", parts).Trim();
}

static string ReadPromptImageSummary(JsonElement root)
{
    if (!root.TryGetProperty("params", out var parameters) ||
        !parameters.TryGetProperty("prompt", out var prompt) ||
        prompt.ValueKind != JsonValueKind.Array)
    {
        return string.Empty;
    }

    foreach (var block in prompt.EnumerateArray())
    {
        if (!string.Equals(GetString(block, "type"), "image", StringComparison.Ordinal)) continue;
        var mimeType = GetString(block, "mimeType") ?? "unknown";
        var data = GetString(block, "data") ?? string.Empty;
        return $" [image {mimeType} {Convert.FromBase64String(data).Length.ToString(CultureInfo.InvariantCulture)} bytes]";
    }

    return string.Empty;
}

static async Task WriteRequestAsync(string id, string method, object parameters)
{
    await WriteJsonAsync(new
    {
        jsonrpc = "2.0",
        id,
        method,
        @params = parameters
    }).ConfigureAwait(false);
}

static async Task WriteNotificationAsync(string method, object parameters)
{
    await WriteJsonAsync(new
    {
        jsonrpc = "2.0",
        method,
        @params = parameters
    }).ConfigureAwait(false);
}

static async Task WriteResponseAsync(JsonElement id, object result)
{
    await WriteJsonAsync(new
    {
        jsonrpc = "2.0",
        id,
        result
    }).ConfigureAwait(false);
}

static async Task WriteJsonAsync<T>(T payload)
{
    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload)).ConfigureAwait(false);
    await Console.Out.FlushAsync().ConfigureAwait(false);
}

static FakeGrokLaunchCapture CreateLaunchCapture()
{
    var args = Environment.GetCommandLineArgs();
    return new FakeGrokLaunchCapture
    {
        ExecutablePath = args.Length > 0 ? args[0] : null,
        Arguments = args.Skip(1).ToArray(),
        ProcessWorkingDirectory = Environment.CurrentDirectory
    };
}

static void PersistLaunchCapture(string? capturePath, FakeGrokLaunchCapture capture)
{
    if (string.IsNullOrWhiteSpace(capturePath))
    {
        return;
    }

    try
    {
        var directory = Path.GetDirectoryName(capturePath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(capturePath, JsonSerializer.Serialize(capture));
    }
    catch
    {
    }
}

static string? GetString(JsonElement element, params string[] path)
{
    var current = element;
    foreach (var segment in path)
    {
        if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
        {
            return null;
        }
    }

    return current.ValueKind == JsonValueKind.String ? current.GetString() : null;
}

internal sealed class FakeGrokLaunchCapture
{
    public string? ExecutablePath { get; set; }

    public string[] Arguments { get; set; } = [];

    public string? ProcessWorkingDirectory { get; set; }
}
