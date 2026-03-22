using System.Text.Json;
using System.Text;

var threadId = "thread-fake-1";
var turnId = "turn-fake-1";
var approvalRequestId = "srv-approval-1";
var userInputRequestId = "srv-user-input-1";
var lastAssistant = string.Empty;

while (await Console.In.ReadLineAsync().ConfigureAwait(false) is { } rawLine)
{
    var line = rawLine.Trim();
    if (line.Length == 0)
    {
        continue;
    }

    JsonDocument document;
    try
    {
        document = JsonDocument.Parse(line);
    }
    catch (JsonException ex)
    {
        await Console.Error.WriteLineAsync($"fake-codex-json-error:{ex.Message}:hex={Convert.ToHexString(Encoding.UTF8.GetBytes(line))}");
        await Console.Error.FlushAsync();
        continue;
    }

    using (document)
    {
        var root = document.RootElement;
        if (root.TryGetProperty("method", out var methodElement) && methodElement.ValueKind == JsonValueKind.String)
        {
            var method = methodElement.GetString();
            switch (method)
            {
                case "initialize":
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        id = root.GetProperty("id").ToString(),
                        result = new { server = "fake-codex" }
                    }).ConfigureAwait(false);
                    continue;
                case "initialized":
                    continue;
                case "thread/start":
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "thread/started",
                        @params = new
                        {
                            thread = new { id = threadId }
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        id = root.GetProperty("id").ToString(),
                        result = new
                        {
                            thread = new { id = threadId }
                        }
                    }).ConfigureAwait(false);
                    continue;
                case "turn/start":
                {
                    var (imageCount, hasFileRef, textValue) = GetInputStats(root);
                    lastAssistant = $"Fake Codex reply. images={imageCount.ToString()} fileRefs={hasFileRef.ToString().ToLowerInvariant()} text={textValue}";
                    var requestUserInput = textValue.Contains("ask user", StringComparison.OrdinalIgnoreCase);

                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        id = root.GetProperty("id").ToString(),
                        result = new
                        {
                            turn = new { id = turnId }
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "turn/started",
                        @params = new
                        {
                            turn = new
                            {
                                id = turnId,
                                model = "gpt-5.4-codex",
                                effort = "high"
                            }
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "item/reasoning/textDelta",
                        @params = new
                        {
                            itemId = "item-reasoning-1",
                            delta = "Inspecting repo through fake codex."
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "item/started",
                        @params = new
                        {
                            item = new
                            {
                                id = "item-tool-1",
                                type = "command_execution",
                                detail = "git status"
                            }
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "item/commandExecution/outputDelta",
                        @params = new
                        {
                            itemId = "item-tool-1",
                            delta = "On branch dev"
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "item/completed",
                        @params = new
                        {
                            item = new
                            {
                                id = "item-tool-1",
                                type = "command_execution",
                                detail = "git status"
                            }
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "item/agentMessage/delta",
                        @params = new
                        {
                            itemId = "item-msg-1",
                            delta = lastAssistant
                        }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "turn/diff/updated",
                        @params = new
                        {
                            unifiedDiff = "--- a/file.txt\n+++ b/file.txt\n@@\n-old\n+new\n"
                        }
                    }).ConfigureAwait(false);

                    if (requestUserInput)
                    {
                        await WriteJsonAsync(new
                        {
                            jsonrpc = "2.0",
                            id = userInputRequestId,
                            method = "item/tool/requestUserInput",
                            @params = new
                            {
                                itemId = "item-user-input-1",
                                questions = new object[]
                                {
                                    new
                                    {
                                        id = "choice",
                                        header = "Mode",
                                        question = "Pick a mode",
                                        multiSelect = false,
                                        options = new object[]
                                        {
                                            new { label = "Safe", description = "Safe mode" },
                                            new { label = "Fast", description = "Fast mode" }
                                        }
                                    }
                                }
                            }
                        }).ConfigureAwait(false);
                    }
                    else
                    {
                        await WriteJsonAsync(new
                        {
                            jsonrpc = "2.0",
                            id = approvalRequestId,
                            method = "item/commandExecution/requestApproval",
                            @params = new
                            {
                                itemId = "item-tool-1",
                                item = new
                                {
                                    id = "item-tool-1",
                                    type = "command_execution",
                                    detail = "git status"
                                }
                            }
                        }).ConfigureAwait(false);
                    }

                    continue;
                }
                case "turn/interrupt":
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        id = root.GetProperty("id").ToString(),
                        result = new { ok = true }
                    }).ConfigureAwait(false);
                    await WriteJsonAsync(new
                    {
                        jsonrpc = "2.0",
                        method = "turn/aborted",
                        @params = new
                        {
                            turnId,
                            reason = "interrupt"
                        }
                    }).ConfigureAwait(false);
                    continue;
            }
        }

        if (root.TryGetProperty("id", out var idElement))
        {
            var id = idElement.ToString();
            if (string.Equals(id, approvalRequestId, StringComparison.Ordinal))
            {
                await WriteJsonAsync(new
                {
                    jsonrpc = "2.0",
                    method = "turn/completed",
                    @params = new
                    {
                        turn = new
                        {
                            id = turnId,
                            status = "completed"
                        }
                    }
                }).ConfigureAwait(false);
                continue;
            }

            if (string.Equals(id, userInputRequestId, StringComparison.Ordinal))
            {
                var answers = root.GetProperty("result").GetProperty("answers").GetProperty("choice").GetProperty("answers")
                    .EnumerateArray()
                    .Select(static answer => answer.GetString())
                    .Where(static answer => !string.IsNullOrWhiteSpace(answer))
                    .ToArray();
                await WriteJsonAsync(new
                {
                    jsonrpc = "2.0",
                    method = "item/completed",
                    @params = new
                    {
                        item = new
                        {
                            id = "item-msg-1",
                            type = "assistant_message",
                            detail = $"{lastAssistant} answer={string.Join(",", answers)}"
                        }
                    }
                }).ConfigureAwait(false);
                await WriteJsonAsync(new
                {
                    jsonrpc = "2.0",
                    method = "turn/completed",
                    @params = new
                    {
                        turn = new
                        {
                            id = turnId,
                            status = "completed"
                        }
                    }
                }).ConfigureAwait(false);
            }
        }
    }
}

static async Task WriteJsonAsync<T>(T payload)
{
    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload)).ConfigureAwait(false);
    await Console.Out.FlushAsync().ConfigureAwait(false);
}

static (int ImageCount, bool HasFileRef, string TextValue) GetInputStats(JsonElement root)
{
    if (!root.TryGetProperty("params", out var parameters) ||
        !parameters.TryGetProperty("input", out var input) ||
        input.ValueKind != JsonValueKind.Array)
    {
        return (0, false, string.Empty);
    }

    var imageCount = 0;
    var textParts = new List<string>();
    foreach (var item in input.EnumerateArray())
    {
        var type = item.TryGetProperty("type", out var typeElement) && typeElement.ValueKind == JsonValueKind.String
            ? typeElement.GetString()
            : string.Empty;
        if (string.Equals(type, "image", StringComparison.Ordinal))
        {
            imageCount++;
            continue;
        }

        if (string.Equals(type, "text", StringComparison.Ordinal) &&
            item.TryGetProperty("text", out var textElement) &&
            textElement.ValueKind == JsonValueKind.String)
        {
            textParts.Add(textElement.GetString() ?? string.Empty);
        }
    }

    var textValue = string.Join("\n", textParts).Trim();
    var hasFileRef = textValue.Contains("Attached file:", StringComparison.Ordinal) ||
                     textValue.Contains("Attached files (", StringComparison.Ordinal);
    return (imageCount, hasFileRef, textValue);
}
