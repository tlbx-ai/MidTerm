using System.Globalization;
using System.Text;
using System.Text.Json;

var sessionId = "grok-session-" + Guid.NewGuid().ToString("N");
var activePromptId = string.Empty;
var activeQuestionId = string.Empty;
var cancelRequested = false;
var delayPlanCompletion = false;
var capturePath = Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_CAPTURE_PATH");
var resumeCapability = Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_RESUME_CAPABILITY") ?? "load";
var v2 = Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_V2") == "true" || args.Contains("--fake-v2", StringComparer.Ordinal);
var v2PromptIndex = 0;
var v2Model = "grok-build-0.1";
var v2Agent = "";
var v2Toggle = false;
var v2ApprovalCount = 0;
var protocolVersion = int.TryParse(
    Environment.GetEnvironmentVariable("MIDTERM_FAKE_GROK_PROTOCOL_VERSION"),
    NumberStyles.Integer,
    CultureInfo.InvariantCulture,
    out var configuredProtocolVersion)
    ? configuredProtocolVersion
    : v2 ? 2 : 1;
PersistLaunchCapture(capturePath, CreateLaunchCapture());

Task WriteV2UpdateAsync(object update) => WriteNotificationAsync("session/update", new { sessionId, update });
Task WriteV2PermissionAsync() => WriteJsonAsync(new
{
    jsonrpc = "2.0", id = "v2-pending-permission", method = "session/request_permission",
    @params = new
    {
        sessionId, toolCall = new { toolCallId = "saved-tool", title = "Restored approval", kind = "execute", status = "pending" },
        options = new[] { new { optionId = "allow-restored", name = "Allow once", kind = "allow_once" }, new { optionId = "deny-restored", name = "Reject once", kind = "reject_once" } }
    }
});

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
        if (v2 && id.ToString() == "v2-pending-permission")
        {
            v2ApprovalCount++;
            await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "running" }).ConfigureAwait(false);
            if (resumeCapability == "resume-waiting-repeat" && v2ApprovalCount == 1)
            {
                await WriteV2PermissionAsync().ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "requires_action" }).ConfigureAwait(false);
                continue;
            }
            await WriteV2UpdateAsync(new { sessionUpdate = "agent_message", messageId = "restored-permission-result", content = new[] { new { type = "text", text = root.GetRawText() } } }).ConfigureAwait(false);
            await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle", stopReason = "end_turn" }).ConfigureAwait(false);
            continue;
        }
        if (id.ToString() == activeQuestionId && !string.IsNullOrWhiteSpace(activePromptId))
        {
            if (delayPlanCompletion)
            {
                delayPlanCompletion = false;
                await Task.Delay(TimeSpan.FromSeconds(12)).ConfigureAwait(false);
            }
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
            if (v2)
            {
                await WriteResponseAsync(id, new
                {
                    protocolVersion,
                    info = new { name = "Fake ACP v2", version = "2" },
                    capabilities = new { session = new { prompt = new { image = new { } } } }
                }).ConfigureAwait(false);
                break;
            }
            await WriteResponseAsync(id, new
            {
                protocolVersion,
                agentCapabilities = new
                {
                    loadSession = resumeCapability is "load" or "reject",
                    sessionCapabilities = new Dictionary<string, object>(StringComparer.Ordinal)
                    {
                        // An empty capability object means supported, not false.
                        [resumeCapability == "resume" ? "resume" : "unused"] = new { }
                    },
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
            if (v2 && resumeCapability == "new-active")
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "running" }).ConfigureAwait(false);
            if (v2 && resumeCapability == "new-background") await WriteV2PermissionAsync().ConfigureAwait(false);
            await WriteResponseAsync(id, v2 ? new
            {
                sessionId,
                configOptions = BuildV2ConfigOptions(v2Model, v2Agent, v2Toggle),
                availableCommands = new[] { new { name = "setup-only", description = "Command supplied by session setup", input = new { type = "_future", hint = "Opaque input", extra = 7 } } }
            } : (object)new
            {
                sessionId,
                models = BuildModelState()
            }).ConfigureAwait(false);
            await WriteNotificationAsync("_x.ai/session/setup", new { sessionId, phase = "ready" }).ConfigureAwait(false);
            if (resumeCapability != "commands-initial-only") await WriteAvailableCommandsUpdateAsync(sessionId).ConfigureAwait(false);
            break;
        case "session/prompt":
            activePromptId = id.ToString();
            var text = ReadPromptText(root);
            var imageSummary = ReadPromptImageSummary(root);
            if (text.StartsWith("usage-check", StringComparison.Ordinal))
            {
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "usage_update", used = 1234, size = 128000, cost = new { amount = 0.0123, currency = "EUR" } } }).ConfigureAwait(false);
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "usage_update", used = (int?)null, size = "invalid", cost = true } }).ConfigureAwait(false);
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "usage_update", used = 2345, size = 128000 } }).ConfigureAwait(false);
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "usage_update", used = -1, size = 128000 } }).ConfigureAwait(false);
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "usage_update", used = 2345, size = 128000, cost = new { amount = "invalid", currency = "USD" } } }).ConfigureAwait(false);
            }
            if (text.StartsWith("commands-clear", StringComparison.Ordinal))
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "available_commands_update", availableCommands = Array.Empty<object>() } }).ConfigureAwait(false);
            if (text.StartsWith("commands-malformed", StringComparison.Ordinal))
                await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "available_commands_update", availableCommands = "invalid" } }).ConfigureAwait(false);
            if (v2)
            {
                // A repeated idle snapshot is not completion of a queued prompt.
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle" }).ConfigureAwait(false);
                var suffix = (++v2PromptIndex).ToString(CultureInfo.InvariantCulture);
                var userMessageId = "v2-user-" + suffix;
                if (text.StartsWith("v2-reject", StringComparison.Ordinal))
                {
                    await WriteJsonAsync(new { jsonrpc = "2.0", id, error = new { code = -32000, message = "Native v2 rejected before insertion." } }).ConfigureAwait(false);
                    activePromptId = string.Empty;
                    break;
                }
                var split = text.Length / 2;
                await WriteV2UpdateAsync(new { sessionUpdate = "user_message_chunk", messageId = userMessageId, content = new { type = "text", text = text[..split] } }).ConfigureAwait(false);
                await WriteResponseAsync(id, new { messageId = userMessageId }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "user_message_chunk", messageId = userMessageId, content = new { type = "text", text = text[split..] } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "running" }).ConfigureAwait(false);
                if (text.StartsWith("v2-hold", StringComparison.Ordinal))
                {
                    await WriteV2UpdateAsync(new { sessionUpdate = "agent_message_chunk", messageId = "v2-answer-" + suffix, content = new { type = "text", text = "Still running after acknowledgement." } }).ConfigureAwait(false);
                    break;
                }
                var sharedId = "v2-shared-" + suffix;
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message", messageId = sharedId, content = new[] { new { type = "text", text = "Obsolete answer" } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message_chunk", messageId = sharedId, content = new { type = "text", text = " draft" } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message", messageId = sharedId, content = new[] { new { type = "text", text = "Correct" } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message", messageId = sharedId }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message_chunk", messageId = sharedId, content = new { type = "text", text = " " } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message_chunk", messageId = sharedId, content = new { type = "text", text = "answer." } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_thought", messageId = sharedId, content = new[] { new { type = "text", text = "Obsolete thought" } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_thought", messageId = sharedId, content = (object?)null }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_thought_chunk", messageId = sharedId, content = new { type = "text", text = "Final thought." } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message", messageId = "v2-other-" + suffix, content = new[] { new { type = "text", text = "Second answer." } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "tool_call_update", toolCallId = sharedId, title = "Initial tool", kind = "other", status = "in_progress", content = new[] { new { type = "content", content = new { type = "text", text = "Obsolete tool evidence" } } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "tool_call_content_chunk", toolCallId = sharedId, content = new { type = "content", content = new { type = "text", text = "\nAppended tool draft" } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "tool_call_update", toolCallId = sharedId, status = "completed", content = new[] { new { type = "content", content = new { type = "text", text = "Final tool evidence" } } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "tool_call_update", toolCallId = sharedId, title = "Updated tool title" }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "tool_call_update", toolCallId = "v2-clear-" + suffix, title = "Cleared tool", status = "completed", content = new[] { new { type = "content", content = new { type = "text", text = "Must be cleared" } } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "tool_call_update", toolCallId = "v2-clear-" + suffix, content = (object?)null }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "plan_update", plan = new { type = "items", planId = "plan-a-" + suffix, entries = new[] { new { content = "Obsolete plan entry", status = "pending", priority = "medium" } } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "plan_update", plan = new { type = "items", planId = "plan-a-" + suffix, entries = new[] { new { content = "Final plan entry", status = "completed", priority = "medium" } } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "plan_update", plan = new { type = "items", planId = "plan-b-" + suffix, entries = new[] { new { content = "Independent plan entry", status = "pending", priority = "low" } } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_update", terminalId = sharedId, command = "echo acceptance", output = new { data = Convert.ToBase64String(Encoding.UTF8.GetBytes("Obsolete terminal bytes")) } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_update", terminalId = sharedId, output = new { data = Convert.ToBase64String(Encoding.UTF8.GetBytes("Grüße ")) } }).ConfigureAwait(false);
                var emojiBytes = Encoding.UTF8.GetBytes("👋");
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_output_chunk", terminalId = sharedId, data = Convert.ToBase64String(emojiBytes[..2]) }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_output_chunk", terminalId = sharedId, data = Convert.ToBase64String(emojiBytes[2..]) }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_output_chunk", terminalId = sharedId, data = Convert.ToBase64String(Encoding.UTF8.GetBytes("\nFinal terminal output.")) }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_update", terminalId = sharedId, exitStatus = new { exitCode = 0 } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_update", terminalId = "clear-terminal-" + suffix, command = "cleared terminal", output = new { data = Convert.ToBase64String(Encoding.UTF8.GetBytes("Obsolete cleared bytes")) } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "terminal_update", terminalId = "clear-terminal-" + suffix, output = (object?)null, exitStatus = new { exitCode = 0 } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "compaction_update", compactionId = sharedId, status = "in_progress", summary = new[] { new { type = "text", text = "Obsolete compaction summary" } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "compaction_update", compactionId = sharedId, status = "in_progress", summary = (object?)null }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "compaction_summary_chunk", compactionId = sharedId, content = new { type = "text", text = "Retained " } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "compaction_summary_chunk", compactionId = sharedId, content = new { type = "text", text = "context." } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "compaction_update", compactionId = sharedId, status = "completed" }).ConfigureAwait(false);
                if (text.StartsWith("v2-error", StringComparison.Ordinal))
                    await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle", stopReason = "error", error = new { code = -32000, message = "Native v2 foreground failure." } }).ConfigureAwait(false);
                else if (text.StartsWith("v2-unknown", StringComparison.Ordinal))
                    await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle" }).ConfigureAwait(false);
                else
                    await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle", stopReason = "end_turn" }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle" }).ConfigureAwait(false);
                activePromptId = string.Empty;
                break;
            }
            if (text.Contains("plan-test", StringComparison.Ordinal))
            {
                delayPlanCompletion = text.Contains("hold", StringComparison.Ordinal);
                activeQuestionId = "grok-plan-1";
                var planMethod = text.Contains("legacy", StringComparison.Ordinal) ? "x.ai/exit_plan_mode" : "_x.ai/exit_plan_mode";
                if (text.Contains("fallback", StringComparison.Ordinal))
                    await WriteNotificationAsync("session/update", new { sessionId, update = new { sessionUpdate = "plan", entries = new[] { new { content = "Saved fallback plan", status = "pending" } } } }).ConfigureAwait(false);
                var planParameters = new
                {
                    sessionId, toolCallId = "plan-tool-1",
                    planContent = text.Contains("fallback", StringComparison.Ordinal) ? null : "  # Acceptance plan\n\n1. Inspect the contract.\n2. Verify the marker.  "
                };
                await WriteJsonAsync(new
                {
                    jsonrpc = "2.0", id = activeQuestionId, method = planMethod,
                    @params = text.Contains("wrapped", StringComparison.Ordinal) ? (object)new { method = planMethod, @params = planParameters } : planParameters
                }).ConfigureAwait(false);
                break;
            }
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
            if (!text.StartsWith("commands-clear", StringComparison.Ordinal)) await WriteAvailableCommandsUpdateAsync(sessionId).ConfigureAwait(false);
            if (!text.StartsWith("usage-check", StringComparison.Ordinal)) await WriteNotificationAsync("session/update", new
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
            if (v2)
            {
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message_chunk", messageId = "v2-answer-" + v2PromptIndex.ToString(CultureInfo.InvariantCulture), content = new { type = "text", text = " Final v2 cancellation tail." } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = "idle", stopReason = "cancelled" }).ConfigureAwait(false);
                activePromptId = string.Empty;
                break;
            }
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
        case "session/set_config_option":
            var configId = GetString(root, "params", "configId");
            var configType = GetString(root, "params", "type");
            var configValue = root.GetProperty("params").GetProperty("value");
            var validConfig = v2 && (configId switch
            {
                "native-model" => configType == "id" && configValue.ValueKind == JsonValueKind.String &&
                    configValue.GetString() is "grok-build-0.1" or "grok-4.3",
                "native-agent" => configType == "id" && configValue.ValueKind == JsonValueKind.String &&
                    configValue.GetString() is "" or "reviewer",
                "native-toggle" => configType == "boolean" && configValue.ValueKind is JsonValueKind.True or JsonValueKind.False,
                _ => false
            });
            if (!validConfig)
            {
                await WriteJsonAsync(new { jsonrpc = "2.0", id, error = new { code = -32602, message = "Invalid native v2 config request." } }).ConfigureAwait(false);
                break;
            }
            if (configId == "native-model") v2Model = configValue.GetString()!;
            if (configId == "native-agent") v2Agent = configValue.GetString()!;
            if (configId == "native-toggle") v2Toggle = configValue.GetBoolean();
            await WriteResponseAsync(id, new { configOptions = BuildV2ConfigOptions(v2Model, v2Agent, v2Toggle) }).ConfigureAwait(false);
            break;
        case "session/load":
        case "session/resume":
            if (resumeCapability == "reject")
            {
                await WriteJsonAsync(new { jsonrpc = "2.0", id, error = new { code = -32000, message = "Saved session was not found." } }).ConfigureAwait(false);
                break;
            }
            sessionId = GetString(root.GetProperty("params"), "sessionId")!;
            if (v2)
            {
                if (GetString(root, "params", "replayFrom", "type") != "start")
                {
                    await WriteJsonAsync(new { jsonrpc = "2.0", id, error = new { code = -32602, message = "Expected native replayFrom start." } }).ConfigureAwait(false);
                    break;
                }
                await WriteV2UpdateAsync(new { sessionUpdate = "user_message", messageId = "saved-user", content = new[] { new { type = "text", text = "Saved v2 question." } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "agent_message", messageId = "saved-agent", content = new[] { new { type = "text", text = "Saved v2 answer." } } }).ConfigureAwait(false);
                await WriteV2UpdateAsync(new { sessionUpdate = "state_update", state = resumeCapability == "resume-active" ? "running" : resumeCapability.StartsWith("resume-waiting", StringComparison.Ordinal) ? "requires_action" : "idle" }).ConfigureAwait(false);
                if (resumeCapability.StartsWith("resume-waiting", StringComparison.Ordinal))
                    await WriteV2PermissionAsync().ConfigureAwait(false);
                await WriteResponseAsync(id, new { }).ConfigureAwait(false);
                break;
            }
            if (method == "session/load")
            {
                foreach (var (role, replayText) in new[]
                {
                    ("user_message_chunk", "Remember "), ("user_message_chunk", "REPLAY_739."),
                    ("agent_message_chunk", "Remembered REPLAY_739."),
                    ("user_message_chunk", "What is the marker?"),
                    ("agent_thought_chunk", "Checking the saved conversation."),
                    ("agent_message_chunk", "The marker is REPLAY_739.")
                })
                {
                    await WriteNotificationAsync("session/update", new
                    {
                        sessionId,
                        update = new { sessionUpdate = role, content = new { type = "text", text = replayText } }
                    }).ConfigureAwait(false);
                }
            }
            // ACP load/resume responses need not repeat sessionId.
            await WriteResponseAsync(id, new { models = BuildModelState() }).ConfigureAwait(false);
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

static object[] BuildV2ConfigOptions(string model, string agent, bool toggle) =>
[
    new { configId = "native-model", category = "model", name = "Model", type = "select", currentValue = model,
        options = new[] { new { groupId = "recommended", name = "Recommended", options = new[]
        {
            new { value = "grok-build-0.1", name = "Default model" }, new { value = "grok-4.3", name = "Other model" }
        } } } },
    new { configId = "secondary-model", category = "model", name = "Secondary model", type = "select", currentValue = "shadow-model",
        options = new[] { new { value = "shadow-model", name = "Secondary choice" } } },
    new { configId = "native-agent", category = "_agent", name = "Agent", description = "Select a native agent.", type = "select", currentValue = agent,
        options = new[] { new { groupId = "agents", name = "Available agents", options = new[]
        { new { value = "", name = "Default agent" }, new { value = "reviewer", name = "Reviewer" } } } } },
    new { configId = "native-toggle", name = "Concise output", description = "Return a concise response.", type = "boolean", currentValue = toggle },
    new { configId = "future-setting", name = "Future control", type = "_custom", currentValue = "keep-me", extraData = new { version = 3 } }
];

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
