using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class ClaudeLensAgentRuntime : ILensAgentRuntime
{
    private const string MidTermUserInputOpenTag = "<midterm-user-input>";
    private const string MidTermUserInputCloseTag = "</midterm-user-input>";
    private const string MidTermUserInputBridgePrompt =
        """
        When you need more information or a decision from the user before you can continue, stop and reply with only one XML block in this exact format:
        <midterm-user-input>{"questions":[{"id":"question-id","header":"Short header","question":"The full question for the user.","multiSelect":false,"options":[{"label":"Option label","description":"Short tradeoff or explanation"}]}]}</midterm-user-input>

        Rules:
        - Output only the XML block and nothing else when requesting user input.
        - Include 1 to 3 questions.
        - Use short stable ids.
        - Use options for multiple-choice questions. Use an empty options array for free-form answers.
        - After the user answers, continue the same task.
        - If you need more input later, use the same XML block format again.
        """;
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private readonly Action<LensHostEventEnvelope> _emit;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Dictionary<int, ClaudeBlockState> _blocks = [];
    private readonly Dictionary<string, ClaudeToolState> _tools = new(StringComparer.Ordinal);
    private Process? _process;
    private StreamReader? _output;
    private StreamReader? _error;
    private StreamWriter? _input;
    private Task? _readerTask;
    private Task? _errorTask;
    private string? _sessionId;
    private string? _workingDirectory;
    private string? _binaryPath;
    private string? _userProfileDirectory;
    private string? _providerThreadId;
    private string? _activeTurnId;
    private string? _activeTurnModel;
    private string? _activeTurnEffort;
    private PendingClaudeUserInput? _pendingUserInput;
    private bool _turnStarted;
    private bool _interruptRequested;
    private long _sequence;

    public ClaudeLensAgentRuntime(Action<LensHostEventEnvelope> emit)
    {
        _emit = emit;
    }

    public string Provider => "claude";

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();
        await DisposeProcessAsync().ConfigureAwait(false);
        _shutdown.Dispose();
        _gate.Dispose();
    }

    public async Task<HostCommandOutcome> ExecuteAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            return command.Type switch
            {
                "runtime.attach" => Attach(command),
                "turn.start" => await StartTurnAsync(command, ct).ConfigureAwait(false),
                "turn.interrupt" => await InterruptTurnAsync(command, ct).ConfigureAwait(false),
                "request.resolve" => throw new InvalidOperationException("Claude Lens request resolution is not available through the current Claude CLI bridge."),
                "user-input.resolve" => await ResolveUserInputAsync(command, ct).ConfigureAwait(false),
                _ => throw new InvalidOperationException($"Unsupported Claude command '{command.Type}'.")
            };
        }
        finally
        {
            _gate.Release();
        }
    }

    private HostCommandOutcome Attach(LensHostCommandEnvelope command)
    {
        var attach = command.AttachRuntime ?? throw new InvalidOperationException("runtime.attach payload is required.");
        if (!string.Equals(attach.Provider, Provider, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Claude runtime cannot attach provider '{attach.Provider}'.");
        }

        if (string.IsNullOrWhiteSpace(attach.WorkingDirectory) || !Directory.Exists(attach.WorkingDirectory))
        {
            throw new InvalidOperationException("Claude working directory is required.");
        }

        var binaryPath = string.IsNullOrWhiteSpace(attach.ExecutablePath)
            ? FindExecutableInPath("claude")
            : attach.ExecutablePath;
        if (string.IsNullOrWhiteSpace(binaryPath) || !File.Exists(binaryPath))
        {
            throw new InvalidOperationException("Claude CLI was not found on PATH.");
        }

        _sessionId = command.SessionId;
        _workingDirectory = attach.WorkingDirectory;
        _binaryPath = binaryPath;
        _userProfileDirectory = attach.UserProfileDirectory;
        if (!string.IsNullOrWhiteSpace(attach.ResumeThreadId))
        {
            _providerThreadId = attach.ResumeThreadId;
        }

        var events = new List<LensHostEventEnvelope>
        {
            CreateEvent("session.started", null, null, null, "mtagenthost.claude", "runtime.attach", attach, lensEvent =>
            {
                lensEvent.SessionState = new LensPulseSessionStatePayload
                {
                    State = "starting",
                    StateLabel = "Starting",
                    Reason = "Claude Lens runtime attached."
                };
            }),
            CreateEvent("session.ready", null, null, null, "mtagenthost.claude", "runtime.attach", attach, lensEvent =>
            {
                lensEvent.SessionState = new LensPulseSessionStatePayload
                {
                    State = "ready",
                    StateLabel = "Ready",
                    Reason = "Claude Lens runtime is ready for the next turn."
                };
            })
        };

        if (!string.IsNullOrWhiteSpace(_providerThreadId))
        {
            events.Add(CreateEvent("thread.started", null, null, null, "mtagenthost.claude", "runtime.attach", attach, lensEvent =>
            {
                lensEvent.ThreadState = new LensPulseThreadStatePayload
                {
                    State = "active",
                    StateLabel = "Active",
                    ProviderThreadId = _providerThreadId
                };
            }));
        }

        return Accepted(command.CommandId, command.SessionId, events: events);
    }

    private async Task<HostCommandOutcome> StartTurnAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        EnsureAttached();
        if (_pendingUserInput is not null)
        {
            throw new InvalidOperationException("Claude is waiting for user input. Resolve the pending question set or interrupt the turn first.");
        }

        if (_process is { HasExited: false } activeProcess)
        {
            await activeProcess.WaitForExitAsync(ct).ConfigureAwait(false);
        }

        if (_process is not null && (_process.HasExited || string.IsNullOrWhiteSpace(_activeTurnId) || _pendingUserInput is not null))
        {
            await DisposeProcessAsync(resetTurnState: false).ConfigureAwait(false);
        }

        if (_process is { HasExited: false })
        {
            throw new InvalidOperationException("Claude already has an active Lens turn.");
        }

        var request = command.StartTurn ?? throw new InvalidOperationException("turn.start payload is required.");
        var prompt = BuildPromptInput(request, out var addDirectories);
        if (string.IsNullOrWhiteSpace(prompt))
        {
            throw new InvalidOperationException("Lens turn input must include text or attachments.");
        }

        await DisposeProcessAsync().ConfigureAwait(false);

        _activeTurnId = "turn-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        _activeTurnModel = request.Model;
        _activeTurnEffort = request.Effort;
        _turnStarted = false;
        _interruptRequested = false;
        _pendingUserInput = null;
        _blocks.Clear();
        _tools.Clear();

        await StartClaudeProcessAsync(prompt, addDirectories, _activeTurnModel, _activeTurnEffort, ct).ConfigureAwait(false);

        return new HostCommandOutcome
        {
            Result = new LensHostCommandResultEnvelope
            {
                CommandId = command.CommandId,
                SessionId = command.SessionId,
                Status = "accepted",
                Accepted = new LensCommandAcceptedResponse
                {
                    SessionId = command.SessionId,
                    Status = "accepted",
                    TurnId = _activeTurnId
                },
                TurnStarted = new LensTurnStartResponse
                {
                    SessionId = command.SessionId,
                    Provider = Provider,
                    ThreadId = _providerThreadId ?? _sessionId ?? command.SessionId,
                    TurnId = _activeTurnId,
                    Status = "accepted"
                }
            }
        };
    }

    private async Task<HostCommandOutcome> ResolveUserInputAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        EnsureAttached();
        var resolution = command.ResolveUserInput ?? throw new InvalidOperationException("user-input.resolve payload is required.");
        var pending = _pendingUserInput;
        if (pending is null || !string.Equals(pending.RequestId, resolution.RequestId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Unknown pending Claude user-input request: {resolution.RequestId}");
        }

        if (_process is not null && (_process.HasExited || string.IsNullOrWhiteSpace(_activeTurnId)))
        {
            await DisposeProcessAsync(resetTurnState: false).ConfigureAwait(false);
        }

        var answers = NormalizeResolvedAnswers(pending, resolution.Answers);
        var continuationPrompt = BuildUserInputAnswerPrompt(pending, answers);
        _pendingUserInput = null;

        try
        {
            await StartClaudeProcessAsync(continuationPrompt, [], _activeTurnModel, _activeTurnEffort, ct).ConfigureAwait(false);
        }
        catch
        {
            _pendingUserInput = pending;
            throw;
        }

        return Accepted(
            command.CommandId,
            command.SessionId,
            accepted: new LensCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                RequestId = resolution.RequestId,
                TurnId = pending.TurnId
            },
            events:
            [
                CreateEvent("user-input.resolved", pending.TurnId, pending.ItemId, resolution.RequestId, "midterm.lens", "claude/user-input.resolve", resolution, lensEvent =>
                {
                    lensEvent.UserInputResolved = new LensPulseUserInputResolvedPayload
                    {
                        Answers = answers
                    };
                }),
                CreateEvent("session.state.changed", pending.TurnId, pending.ItemId, resolution.RequestId, "midterm.lens", "claude/user-input.resolve", resolution, lensEvent =>
                {
                    lensEvent.SessionState = new LensPulseSessionStatePayload
                    {
                        State = "resuming",
                        StateLabel = "Resuming",
                        Reason = "Claude is continuing after user input."
                    };
                })
            ]);
    }

    private async Task<HostCommandOutcome> InterruptTurnAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        var turnId = string.IsNullOrWhiteSpace(command.InterruptTurn?.TurnId)
            ? _activeTurnId
            : command.InterruptTurn!.TurnId;
        if (string.IsNullOrWhiteSpace(turnId))
        {
            throw new InvalidOperationException("Claude does not have an active turn to interrupt.");
        }

        if (_process is { HasExited: false } process)
        {
            _interruptRequested = true;
            try
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(ct).ConfigureAwait(false);
            }
            catch
            {
            }

            await DisposeProcessAsync(resetTurnState: false).ConfigureAwait(false);
        }

        ResetTurnState();

        return Accepted(
            command.CommandId,
            command.SessionId,
            accepted: new LensCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                TurnId = turnId
            },
            events:
            [
                CreateEvent("turn.aborted", turnId, null, null, "mtagenthost.claude", "turn.interrupt", command.InterruptTurn, lensEvent =>
                {
                    lensEvent.TurnCompleted = new LensPulseTurnCompletedPayload
                    {
                        State = "interrupted",
                        StateLabel = "Interrupted",
                        StopReason = "interrupt"
                    };
                }),
                CreateEvent("session.state.changed", turnId, null, null, "mtagenthost.claude", "turn.interrupt", command.InterruptTurn, lensEvent =>
                {
                    lensEvent.SessionState = new LensPulseSessionStatePayload
                    {
                        State = "ready",
                        StateLabel = "Ready",
                        Reason = "Claude turn interrupted."
                    };
                })
            ]);
    }

    private async Task ReadLoopAsync(Process process, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && !process.HasExited && _output is not null)
            {
                var line = await _output.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (!string.IsNullOrWhiteSpace(line))
                {
                    HandleClaudeLine(line);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            EmitRuntimeMessage("runtime.error", "Claude Lens stream failed.", ex.Message);
        }
        finally
        {
            await FinalizeExitAsync(process).ConfigureAwait(false);
        }
    }

    private async Task ReadErrorLoopAsync(Process process, CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && !process.HasExited && _error is not null)
            {
                var line = await _error.ReadLineAsync(ct).ConfigureAwait(false);
                if (line is null)
                {
                    break;
                }

                if (!string.IsNullOrWhiteSpace(line))
                {
                    EmitRuntimeMessage("runtime.warning", line.Trim(), line.Trim());
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch
        {
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private async Task FinalizeExitAsync(Process process)
    {
        try
        {
            await process.WaitForExitAsync().ConfigureAwait(false);
        }
        catch
        {
        }

        if (!_interruptRequested && !string.IsNullOrWhiteSpace(_activeTurnId) && process.ExitCode != 0)
        {
            _emit(CreateEvent("turn.completed", _activeTurnId, null, null, "claude.stream-json", "process.exit", new { exitCode = process.ExitCode }, lensEvent =>
            {
                lensEvent.TurnCompleted = new LensPulseTurnCompletedPayload
                {
                    State = "failed",
                    StateLabel = "Failed",
                    StopReason = "process_exit",
                    ErrorMessage = $"Claude exited with code {process.ExitCode.ToString(CultureInfo.InvariantCulture)}."
                };
            }));
            EmitRuntimeMessage("runtime.error", "Claude Lens process exited unexpectedly.", $"Exit code {process.ExitCode.ToString(CultureInfo.InvariantCulture)}.");
        }

        if (ReferenceEquals(_process, process))
        {
            try { _input?.Dispose(); } catch { }
            try { _output?.Dispose(); } catch { }
            try { _error?.Dispose(); } catch { }
            try { _process?.Dispose(); } catch { }
            _process = null;
            _input = null;
            _output = null;
            _error = null;
        }
    }

    private void HandleClaudeLine(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;
        var type = GetString(root, "type");
        if (string.IsNullOrWhiteSpace(type))
        {
            return;
        }

        EnsureProviderThreadId(root);

        switch (type)
        {
            case "stream_event":
                HandleStreamEvent(root, line);
                break;
            case "assistant":
                HandleAssistant(root, line);
                break;
            case "user":
                HandleUser(root, line);
                break;
            case "result":
                HandleResult(root, line);
                break;
        }
    }

    private void HandleStreamEvent(JsonElement root, string rawLine)
    {
        var eventType = GetString(root, "event", "type");
        switch (eventType)
        {
            case "message_start":
                if (!string.IsNullOrWhiteSpace(_activeTurnId))
                {
                    _emit(CreateEvent("session.state.changed", _activeTurnId, null, null, "claude.stream-json", "message_start", root, lensEvent =>
                    {
                        lensEvent.SessionState = new LensPulseSessionStatePayload
                        {
                            State = "running",
                            StateLabel = "Running",
                            Reason = "Claude turn started."
                        };
                    }, rawLine));

                    if (!_turnStarted)
                    {
                        _turnStarted = true;
                        _emit(CreateEvent("turn.started", _activeTurnId, null, null, "claude.stream-json", "message_start", root, lensEvent =>
                        {
                            lensEvent.TurnStarted = new LensPulseTurnStartedPayload
                            {
                                Model = GetString(root, "event", "message", "model") ?? _activeTurnModel,
                                Effort = _activeTurnEffort
                            };
                        }, rawLine));
                    }
                }
                break;
            case "content_block_start":
                HandleContentBlockStart(root, rawLine);
                break;
            case "content_block_delta":
                HandleContentBlockDelta(root, rawLine);
                break;
        }
    }

    private void HandleContentBlockStart(JsonElement root, string rawLine)
    {
        var index = GetInt32(root, "event", "index");
        var block = Traverse(root, "event", "content_block");
        if (index is null || block is not { ValueKind: JsonValueKind.Object } contentBlock)
        {
            return;
        }

        var state = new ClaudeBlockState
        {
            Type = GetString(contentBlock, "type") ?? string.Empty,
            ProviderItemId = GetString(contentBlock, "id"),
            Title = GetString(contentBlock, "name") ?? "Tool"
        };
        _blocks[index.Value] = state;

        if (string.IsNullOrWhiteSpace(_activeTurnId) || !string.Equals(state.Type, "tool_use", StringComparison.Ordinal))
        {
            return;
        }

        var itemId = string.IsNullOrWhiteSpace(state.ProviderItemId)
            ? $"tool:{_activeTurnId}:{index.Value.ToString(CultureInfo.InvariantCulture)}"
            : state.ProviderItemId;
        state.ItemId = itemId;
        var detail = contentBlock.TryGetProperty("input", out var input) ? input.GetRawText() : state.Title;
        var itemType = NormalizeToolItemType(state.Title);
        state.Detail.Append(detail);
        _tools[state.ProviderItemId ?? itemId] = new ClaudeToolState
        {
            ItemId = itemId,
            ItemType = itemType,
            Title = state.Title,
            Detail = new StringBuilder(detail)
        };

        _emit(CreateEvent("item.started", _activeTurnId, itemId, null, "claude.stream-json", "content_block_start", root, lensEvent =>
        {
            lensEvent.Item = new LensPulseItemPayload
            {
                ItemType = itemType,
                Status = "in_progress",
                Title = state.Title,
                Detail = detail
            };
        }, rawLine));
    }

    private void HandleContentBlockDelta(JsonElement root, string rawLine)
    {
        var index = GetInt32(root, "event", "index");
        if (index is null || !_blocks.TryGetValue(index.Value, out var state) || string.IsNullOrWhiteSpace(_activeTurnId))
        {
            return;
        }

        var deltaType = GetString(root, "event", "delta", "type");
        switch (deltaType)
        {
            case "text_delta":
            {
                var delta = GetString(root, "event", "delta", "text");
                if (string.IsNullOrWhiteSpace(delta))
                {
                    return;
                }

                if (IsReasoningBlock(state.Type))
                {
                    _emit(CreateEvent("content.delta", _activeTurnId, state.ItemId, null, "claude.stream-json", "content_block_delta", root, lensEvent =>
                    {
                        lensEvent.ContentDelta = new LensPulseContentDeltaPayload
                        {
                            StreamKind = "reasoning_text",
                            Delta = delta
                        };
                    }, rawLine));
                }
                else
                {
                    state.Detail.Append(delta);
                }

                break;
            }
            case "input_json_delta":
            {
                var partialJson = GetString(root, "event", "delta", "partial_json");
                if (string.IsNullOrWhiteSpace(partialJson))
                {
                    return;
                }

                state.Detail.Append(partialJson);
                var toolKey = state.ProviderItemId ?? state.ItemId ?? string.Empty;
                if (_tools.TryGetValue(toolKey, out var tool))
                {
                    tool.Detail.Append(partialJson);
                    _emit(CreateEvent("item.updated", _activeTurnId, tool.ItemId, null, "claude.stream-json", "content_block_delta", root, lensEvent =>
                    {
                        lensEvent.Item = new LensPulseItemPayload
                        {
                            ItemType = tool.ItemType,
                            Status = "in_progress",
                            Title = tool.Title,
                            Detail = tool.Detail.ToString()
                        };
                    }, rawLine));
                }

                break;
            }
        }
    }

    private void HandleAssistant(JsonElement root, string rawLine)
    {
        var text = JoinClaudeAssistantText(root);
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(_activeTurnId))
        {
            return;
        }

        if (TryParseUserInputRequest(text, out var questions, out var visibleAssistantText))
        {
            if (!string.IsNullOrWhiteSpace(visibleAssistantText))
            {
                EmitAssistantMessage(visibleAssistantText, root, rawLine);
            }

            var requestId = "ui-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
            var itemId = $"assistant:{_activeTurnId}";
            _pendingUserInput = new PendingClaudeUserInput
            {
                RequestId = requestId,
                TurnId = _activeTurnId,
                ItemId = itemId,
                Questions = questions
            };

            _emit(CreateEvent("user-input.requested", _activeTurnId, itemId, requestId, "claude.stream-json", "assistant", root, lensEvent =>
            {
                lensEvent.UserInputRequested = new LensPulseUserInputRequestedPayload
                {
                    Questions = questions
                };
            }, rawLine));
            _emit(CreateEvent("session.state.changed", _activeTurnId, itemId, requestId, "claude.stream-json", "assistant", root, lensEvent =>
            {
                lensEvent.SessionState = new LensPulseSessionStatePayload
                {
                    State = "waiting_for_input",
                    StateLabel = "Waiting for input",
                    Reason = BuildQuestionSummary(questions)
                };
            }, rawLine));
            return;
        }

        EmitAssistantMessage(text, root, rawLine);
    }

    private void EmitAssistantMessage(string text, JsonElement root, string rawLine)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(_activeTurnId))
        {
            return;
        }

        var itemId = $"assistant:{_activeTurnId}";
        _emit(CreateEvent("content.delta", _activeTurnId, itemId, null, "claude.stream-json", "assistant", root, lensEvent =>
        {
            lensEvent.ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = text
            };
        }, rawLine));
        _emit(CreateEvent("item.completed", _activeTurnId, itemId, null, "claude.stream-json", "assistant", root, lensEvent =>
        {
            lensEvent.Item = new LensPulseItemPayload
            {
                ItemType = "assistant_message",
                Status = "completed",
                Title = "Assistant message",
                Detail = text
            };
        }, rawLine));
    }

    private void HandleUser(JsonElement root, string rawLine)
    {
        if (string.IsNullOrWhiteSpace(_activeTurnId) ||
            !root.TryGetProperty("message", out var message) ||
            !message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var item in content.EnumerateArray())
        {
            if (!string.Equals(GetString(item, "type"), "tool_result", StringComparison.Ordinal))
            {
                continue;
            }

            var toolUseId = GetString(item, "tool_use_id") ?? GetString(root, "tool_use_result", "tool_use_id");
            if (string.IsNullOrWhiteSpace(toolUseId) || !_tools.TryGetValue(toolUseId, out var tool))
            {
                continue;
            }

            var resultText = ReadToolResultText(item, root);
            if (!string.IsNullOrWhiteSpace(resultText) && string.Equals(tool.ItemType, "command_execution", StringComparison.Ordinal))
            {
                _emit(CreateEvent("content.delta", _activeTurnId, tool.ItemId, null, "claude.stream-json", "tool_result", root, lensEvent =>
                {
                    lensEvent.ContentDelta = new LensPulseContentDeltaPayload
                    {
                        StreamKind = "command_output",
                        Delta = resultText
                    };
                }, rawLine));
            }

            _emit(CreateEvent("item.completed", _activeTurnId, tool.ItemId, null, "claude.stream-json", "tool_result", root, lensEvent =>
            {
                lensEvent.Item = new LensPulseItemPayload
                {
                    ItemType = tool.ItemType,
                    Status = "completed",
                    Title = tool.Title,
                    Detail = CombineToolDetail(tool.Detail.ToString(), resultText)
                };
            }, rawLine));
            _tools.Remove(toolUseId);
        }
    }

    private void HandleResult(JsonElement root, string rawLine)
    {
        if (string.IsNullOrWhiteSpace(_activeTurnId))
        {
            return;
        }

        var isError = GetBoolean(root, "is_error");
        var subtype = GetString(root, "subtype") ?? (isError ? "error" : "success");
        var resultText = GetString(root, "result");
        if (!isError && _pendingUserInput is not null)
        {
            _blocks.Clear();
            _tools.Clear();
            _interruptRequested = false;
            return;
        }

        _emit(CreateEvent("turn.completed", _activeTurnId, null, null, "claude.stream-json", "result", root, lensEvent =>
        {
            lensEvent.TurnCompleted = new LensPulseTurnCompletedPayload
            {
                State = isError ? "failed" : "completed",
                StateLabel = isError ? "Failed" : "Completed",
                StopReason = subtype,
                ErrorMessage = isError ? resultText : null
            };
        }, rawLine));
        _emit(CreateEvent("session.state.changed", _activeTurnId, null, null, "claude.stream-json", "result", root, lensEvent =>
        {
            lensEvent.SessionState = new LensPulseSessionStatePayload
            {
                State = isError ? "error" : "ready",
                StateLabel = isError ? "Error" : "Ready",
                Reason = string.IsNullOrWhiteSpace(resultText)
                    ? (isError ? "Claude turn failed." : "Claude turn completed.")
                    : resultText
            };
        }, rawLine));

        ResetTurnState();
    }

    private void EnsureProviderThreadId(JsonElement root)
    {
        var providerThreadId = GetString(root, "session_id");
        if (string.IsNullOrWhiteSpace(providerThreadId) || string.Equals(providerThreadId, _providerThreadId, StringComparison.Ordinal))
        {
            return;
        }

        _providerThreadId = providerThreadId;
        _emit(CreateEvent("thread.started", null, null, null, "claude.stream-json", "session_id", root, lensEvent =>
        {
            lensEvent.ThreadState = new LensPulseThreadStatePayload
            {
                State = "active",
                StateLabel = "Active",
                ProviderThreadId = providerThreadId
            };
        }));
    }

    private void EmitRuntimeMessage(string eventType, string message, string? detail)
    {
        _emit(CreateEvent(eventType, _activeTurnId, null, null, "mtagenthost.claude", eventType, new { message, detail }, lensEvent =>
        {
            lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
            {
                Message = message,
                Detail = detail
            };
        }));
    }

    private HostCommandOutcome Accepted(
        string commandId,
        string sessionId,
        LensCommandAcceptedResponse? accepted = null,
        IReadOnlyList<LensHostEventEnvelope>? events = null)
    {
        return new HostCommandOutcome
        {
            Result = new LensHostCommandResultEnvelope
            {
                CommandId = commandId,
                SessionId = sessionId,
                Status = "accepted",
                Accepted = accepted ?? new LensCommandAcceptedResponse
                {
                    SessionId = sessionId,
                    Status = "accepted",
                    TurnId = _activeTurnId
                }
            },
            Events = events ?? []
        };
    }

    private LensHostEventEnvelope CreateEvent(
        string eventType,
        string? turnId,
        string? itemId,
        string? requestId,
        string source,
        string? method,
        object? payload,
        Action<LensPulseEvent>? configure = null,
        string? rawPayloadJson = null)
    {
        var lensEvent = new LensPulseEvent
        {
            Sequence = Interlocked.Increment(ref _sequence),
            EventId = $"evt-{Provider}-{_sequence.ToString(CultureInfo.InvariantCulture)}",
            SessionId = _sessionId ?? string.Empty,
            Provider = Provider,
            ThreadId = _providerThreadId ?? _sessionId ?? string.Empty,
            TurnId = turnId,
            ItemId = itemId,
            RequestId = requestId,
            CreatedAt = DateTimeOffset.UtcNow,
            Type = eventType,
            Raw = new LensPulseEventRaw
            {
                Source = source,
                Method = method,
                PayloadJson = rawPayloadJson ?? SerializePayload(payload)
            }
        };
        configure?.Invoke(lensEvent);
        return new LensHostEventEnvelope
        {
            SessionId = _sessionId ?? string.Empty,
            Event = lensEvent
        };
    }

    private static string? SerializePayload(object? payload)
    {
        return payload switch
        {
            null => null,
            JsonElement element => element.GetRawText(),
            string text => text,
            _ => payload.ToString()
        };
    }

    private void EnsureAttached()
    {
        if (string.IsNullOrWhiteSpace(_sessionId) ||
            string.IsNullOrWhiteSpace(_workingDirectory) ||
            string.IsNullOrWhiteSpace(_binaryPath))
        {
            throw new InvalidOperationException("Claude Lens runtime is not attached.");
        }
    }

    private async Task StartClaudeProcessAsync(
        string prompt,
        IReadOnlyList<string> addDirectories,
        string? model,
        string? effort,
        CancellationToken ct)
    {
        var process = new Process
        {
            StartInfo = CreateProcessStartInfo(_binaryPath!, BuildArguments(model, effort, addDirectories), _workingDirectory!),
            EnableRaisingEvents = true
        };
        LensProviderRuntimeConfiguration.ApplyUserProfileEnvironment(process.StartInfo, _userProfileDirectory);
        LensProviderRuntimeConfiguration.ApplyEnvironmentVariables(process.StartInfo, Provider);
        if (!process.Start())
        {
            throw new InvalidOperationException("Claude process could not be started.");
        }

        _process = process;
        _output = process.StandardOutput;
        _error = process.StandardError;
        _input = process.StandardInput;
        _readerTask = Task.Run(() => ReadLoopAsync(process, CancellationToken.None), CancellationToken.None);
        _errorTask = Task.Run(() => ReadErrorLoopAsync(process, CancellationToken.None), CancellationToken.None);
        await _input.WriteAsync(prompt.AsMemory(), ct).ConfigureAwait(false);
        await _input.FlushAsync().ConfigureAwait(false);
        _input.Close();
    }

    private async Task DisposeProcessAsync(bool resetTurnState = true)
    {
        try
        {
            if (_process is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
        }
        catch
        {
        }

        try { _input?.Dispose(); } catch { }
        try { _output?.Dispose(); } catch { }
        try { _error?.Dispose(); } catch { }
        try { _process?.Dispose(); } catch { }

        if (_readerTask is not null)
        {
            await Task.WhenAny(_readerTask, Task.Delay(250)).ConfigureAwait(false);
        }

        if (_errorTask is not null)
        {
            await Task.WhenAny(_errorTask, Task.Delay(250)).ConfigureAwait(false);
        }

        _process = null;
        _input = null;
        _output = null;
        _error = null;
        _readerTask = null;
        _errorTask = null;

        if (resetTurnState)
        {
            ResetTurnState();
        }
    }

    private static string BuildPromptInput(LensTurnRequest request, out List<string> addDirectories)
    {
        addDirectories = [];
        var text = (request.Text ?? string.Empty).Trim();
        if (request.Attachments.Count == 0)
        {
            return text;
        }

        var builder = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(text))
        {
            builder.AppendLine(text);
            builder.AppendLine();
        }

        builder.AppendLine(request.Attachments.Count == 1 ? "Attached resource:" : $"Attached resources ({request.Attachments.Count.ToString(CultureInfo.InvariantCulture)}):");
        foreach (var attachment in request.Attachments)
        {
            if (string.IsNullOrWhiteSpace(attachment.Path))
            {
                continue;
            }

            if (!File.Exists(attachment.Path))
            {
                throw new InvalidOperationException($"Lens attachment does not exist: {attachment.Path}");
            }

            var parent = Path.GetDirectoryName(attachment.Path);
            if (!string.IsNullOrWhiteSpace(parent))
            {
                addDirectories.Add(parent);
            }

            builder.Append("- ");
            builder.Append(string.Equals(attachment.Kind, "image", StringComparison.OrdinalIgnoreCase) ? "[image] " : "[file] ");
            builder.AppendLine(attachment.Path);
        }

        return builder.ToString().Trim();
    }

    private string BuildArguments(string? model, string? effort, IReadOnlyList<string> addDirectories)
    {
        var args = new List<string>
        {
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--append-system-prompt",
            MidTermUserInputBridgePrompt
        };

        if (LensProviderRuntimeConfiguration.GetClaudeDangerouslySkipPermissionsDefault())
        {
            args.Add("--dangerously-skip-permissions");
        }

        if (!string.IsNullOrWhiteSpace(_providerThreadId))
        {
            args.Add("--resume");
            args.Add(_providerThreadId);
        }

        if (!string.IsNullOrWhiteSpace(model))
        {
            args.Add("--model");
            args.Add(model);
        }

        if (!string.IsNullOrWhiteSpace(effort))
        {
            args.Add("--effort");
            args.Add(effort);
        }

        foreach (var directory in addDirectories.Where(static value => !string.IsNullOrWhiteSpace(value)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            args.Add("--add-dir");
            args.Add(directory);
        }

        return string.Join(" ", args.Select(QuoteArgument));
    }

    private static List<LensPulseAnsweredQuestion> NormalizeResolvedAnswers(
        PendingClaudeUserInput pending,
        IReadOnlyList<LensPulseAnsweredQuestion> answers)
    {
        var resolvedById = answers
            .Where(static answer => !string.IsNullOrWhiteSpace(answer.QuestionId))
            .GroupBy(answer => answer.QuestionId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);

        var normalized = new List<LensPulseAnsweredQuestion>(pending.Questions.Count);
        foreach (var question in pending.Questions)
        {
            if (!resolvedById.TryGetValue(question.Id, out var answer))
            {
                normalized.Add(new LensPulseAnsweredQuestion
                {
                    QuestionId = question.Id,
                    Answers = []
                });
                continue;
            }

            normalized.Add(new LensPulseAnsweredQuestion
            {
                QuestionId = question.Id,
                Answers = [.. answer.Answers.Where(static value => !string.IsNullOrWhiteSpace(value))]
            });
        }

        return normalized;
    }

    private static string BuildUserInputAnswerPrompt(PendingClaudeUserInput pending, IReadOnlyList<LensPulseAnsweredQuestion> answers)
    {
        var builder = new StringBuilder();
        builder.AppendLine("User answers for your previous MidTerm input request:");
        builder.AppendLine();

        foreach (var question in pending.Questions)
        {
            var answer = answers.FirstOrDefault(candidate => string.Equals(candidate.QuestionId, question.Id, StringComparison.Ordinal));
            var answerText = answer is null || answer.Answers.Count == 0
                ? "(no answer provided)"
                : string.Join(", ", answer.Answers);
        builder.Append("- ");
        builder.Append(question.Header);
        builder.Append(" [");
        builder.Append(question.Id);
            builder.Append("]: ");
            builder.AppendLine(answerText);
        }

        builder.AppendLine();
        builder.Append("Continue the same task. If you still need user input later, use the same MidTerm XML input block format again and keep that request machine-readable.");
        return builder.ToString();
    }

    private static bool TryParseUserInputRequest(
        string assistantText,
        out List<LensPulseQuestion> questions,
        out string visibleAssistantText)
    {
        questions = [];
        visibleAssistantText = assistantText.Trim();
        var startIndex = assistantText.IndexOf(MidTermUserInputOpenTag, StringComparison.OrdinalIgnoreCase);
        if (startIndex < 0)
        {
            return false;
        }

        var endIndex = assistantText.IndexOf(MidTermUserInputCloseTag, startIndex + MidTermUserInputOpenTag.Length, StringComparison.OrdinalIgnoreCase);
        if (endIndex < 0)
        {
            return false;
        }

        var before = assistantText[..startIndex].Trim();
        var after = assistantText[(endIndex + MidTermUserInputCloseTag.Length)..].Trim();
        visibleAssistantText = string.Join(Environment.NewLine, new[] { before, after }.Where(static value => !string.IsNullOrWhiteSpace(value)));

        var jsonText = assistantText.Substring(startIndex + MidTermUserInputOpenTag.Length, endIndex - startIndex - MidTermUserInputOpenTag.Length).Trim();
        if (string.IsNullOrWhiteSpace(jsonText))
        {
            return false;
        }

        try
        {
            using var document = JsonDocument.Parse(jsonText);
            var questionArray = document.RootElement.ValueKind switch
            {
                JsonValueKind.Array => document.RootElement,
                JsonValueKind.Object when document.RootElement.TryGetProperty("questions", out var parsedQuestions) => parsedQuestions,
                _ => default
            };
            if (questionArray.ValueKind != JsonValueKind.Array)
            {
                return false;
            }

            var index = 0;
            foreach (var entry in questionArray.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object)
                {
                    index++;
                    continue;
                }

                var header = GetString(entry, "header");
                var question = GetString(entry, "question");
                var normalizedHeader = string.IsNullOrWhiteSpace(header) ? $"Question {index + 1}" : header.Trim();
                var normalizedQuestion = string.IsNullOrWhiteSpace(question) ? normalizedHeader : question.Trim();
                var id = NormalizeQuestionId(GetString(entry, "id"), normalizedHeader, index);
                var options = new List<LensPulseQuestionOption>();
                if (entry.TryGetProperty("options", out var optionArray) && optionArray.ValueKind == JsonValueKind.Array)
                {
                    foreach (var option in optionArray.EnumerateArray())
                    {
                        if (option.ValueKind != JsonValueKind.Object)
                        {
                            continue;
                        }

                        var label = GetString(option, "label");
                        if (string.IsNullOrWhiteSpace(label))
                        {
                            continue;
                        }

                        options.Add(new LensPulseQuestionOption
                        {
                            Label = label.Trim(),
                            Description = (GetString(option, "description") ?? string.Empty).Trim()
                        });
                    }
                }

                questions.Add(new LensPulseQuestion
                {
                    Id = id,
                    Header = normalizedHeader,
                    Question = normalizedQuestion,
                    MultiSelect = GetBoolean(entry, "multiSelect"),
                    Options = options
                });
                index++;
            }

            return questions.Count > 0;
        }
        catch
        {
            return false;
        }
    }

    private static string NormalizeQuestionId(string? candidate, string header, int index)
    {
        var source = string.IsNullOrWhiteSpace(candidate) ? header : candidate;
        var builder = new StringBuilder();
        foreach (var ch in source)
        {
            if (char.IsLetterOrDigit(ch))
            {
                builder.Append(char.ToLowerInvariant(ch));
                continue;
            }

            if (builder.Length > 0 && builder[^1] != '-')
            {
                builder.Append('-');
            }
        }

        var normalized = builder.ToString().Trim('-');
        return string.IsNullOrWhiteSpace(normalized) ? $"question-{index + 1}" : normalized;
    }

    private static string BuildQuestionSummary(IReadOnlyList<LensPulseQuestion> questions)
    {
        return string.Join(
            " | ",
            questions.Select(static question =>
                string.IsNullOrWhiteSpace(question.Question)
                    ? question.Header
                    : $"{question.Header}: {question.Question}"));
    }

    private static string JoinClaudeAssistantText(JsonElement root)
    {
        if (!root.TryGetProperty("message", out var message) ||
            !message.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var item in content.EnumerateArray())
        {
            if (string.Equals(GetString(item, "type"), "text", StringComparison.OrdinalIgnoreCase))
            {
                builder.Append(GetString(item, "text"));
            }
        }

        return builder.ToString();
    }

    private static string ReadToolResultText(JsonElement item, JsonElement root)
    {
        var parts = new List<string>();
        if (item.TryGetProperty("content", out var content))
        {
            var contentText = content.ValueKind switch
            {
                JsonValueKind.String => content.GetString(),
                JsonValueKind.Array => string.Join(
                    Environment.NewLine,
                    content.EnumerateArray()
                        .Select(static part => GetString(part, "text") ?? part.ToString())
                        .Where(static value => !string.IsNullOrWhiteSpace(value))),
                _ => content.ToString()
            };
            if (!string.IsNullOrWhiteSpace(contentText))
            {
                parts.Add(contentText);
            }
        }

        var stdout = GetString(root, "tool_use_result", "stdout");
        if (!string.IsNullOrWhiteSpace(stdout))
        {
            parts.Add(stdout);
        }

        var stderr = GetString(root, "tool_use_result", "stderr");
        if (!string.IsNullOrWhiteSpace(stderr))
        {
            parts.Add(stderr);
        }

        return string.Join(Environment.NewLine, parts);
    }

    private static string CombineToolDetail(string? invocationDetail, string? resultText)
    {
        if (string.IsNullOrWhiteSpace(invocationDetail))
        {
            return resultText ?? string.Empty;
        }

        if (string.IsNullOrWhiteSpace(resultText))
        {
            return invocationDetail;
        }

        return invocationDetail.Trim() + Environment.NewLine + Environment.NewLine + resultText.Trim();
    }

    private static string NormalizeToolItemType(string? toolName)
    {
        return toolName?.Trim().ToLowerInvariant() switch
        {
            "bash" => "command_execution",
            _ => "dynamic_tool_call"
        };
    }

    private static bool IsReasoningBlock(string? blockType)
    {
        return string.Equals(blockType, "thinking", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(blockType, "redacted_thinking", StringComparison.OrdinalIgnoreCase);
    }

    private static ProcessStartInfo CreateProcessStartInfo(string binaryPath, string arguments, string workingDirectory)
    {
        if (OperatingSystem.IsWindows())
        {
            var extension = Path.GetExtension(binaryPath);
            if (extension.Equals(".cmd", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".bat", StringComparison.OrdinalIgnoreCase))
            {
                var comspec = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
                return new ProcessStartInfo
                {
                    FileName = comspec,
                    Arguments = $"/d /c \"\"{binaryPath}\" {arguments}\"",
                    WorkingDirectory = workingDirectory,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Utf8NoBom,
                    StandardErrorEncoding = Utf8NoBom,
                    StandardInputEncoding = Utf8NoBom
                };
            }
        }

        return new ProcessStartInfo
        {
            FileName = binaryPath,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Utf8NoBom,
            StandardErrorEncoding = Utf8NoBom,
            StandardInputEncoding = Utf8NoBom
        };
    }

    private static string QuoteArgument(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }

        return value.Any(static ch => char.IsWhiteSpace(ch) || ch is '"' or '\\')
            ? "\"" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\""
            : value;
    }

    private static string? FindExecutableInPath(string commandName)
    {
        if (Path.IsPathRooted(commandName) && File.Exists(commandName))
        {
            return commandName;
        }

        var pathVar = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathVar))
        {
            return null;
        }

        var candidateNames = OperatingSystem.IsWindows() ? GetWindowsExecutableNames(commandName) : [commandName];
        foreach (var rawDirectory in pathVar.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var directory = rawDirectory.Trim().Trim('"');
            if (string.IsNullOrWhiteSpace(directory))
            {
                continue;
            }

            foreach (var candidateName in candidateNames)
            {
                var fullPath = Path.Combine(directory, candidateName);
                if (File.Exists(fullPath))
                {
                    return fullPath;
                }
            }
        }

        return null;
    }

    private static string[] GetWindowsExecutableNames(string commandName)
    {
        if (!string.IsNullOrWhiteSpace(Path.GetExtension(commandName)))
        {
            return [commandName];
        }

        var pathext = Environment.GetEnvironmentVariable("PATHEXT");
        var extensions = string.IsNullOrWhiteSpace(pathext)
            ? [".exe", ".cmd", ".bat"]
            : pathext.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        return extensions.Select(ext => commandName + ext.ToLowerInvariant()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string? GetString(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;
    }

    private static bool GetBoolean(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.True } || current is { ValueKind: JsonValueKind.False } value && value.GetBoolean();
    }

    private static int? GetInt32(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.Number } value && value.TryGetInt32(out var parsed)
            ? parsed
            : null;
    }

    private static JsonElement? Traverse(JsonElement element, params string[] path)
    {
        var current = element;
        foreach (var segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }

        return current;
    }

    private void ResetTurnState()
    {
        _activeTurnId = null;
        _activeTurnModel = null;
        _activeTurnEffort = null;
        _pendingUserInput = null;
        _turnStarted = false;
        _interruptRequested = false;
        _blocks.Clear();
        _tools.Clear();
    }

    private sealed class ClaudeBlockState
    {
        public string Type { get; set; } = string.Empty;
        public string? ProviderItemId { get; set; }
        public string? ItemId { get; set; }
        public string Title { get; set; } = string.Empty;
        public StringBuilder Detail { get; } = new();
    }

    private sealed class ClaudeToolState
    {
        public string ItemId { get; set; } = string.Empty;
        public string ItemType { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public StringBuilder Detail { get; set; } = new();
    }

    private sealed class PendingClaudeUserInput
    {
        public string RequestId { get; set; } = string.Empty;
        public string TurnId { get; set; } = string.Empty;
        public string? ItemId { get; set; }
        public List<LensPulseQuestion> Questions { get; set; } = [];
    }
}
