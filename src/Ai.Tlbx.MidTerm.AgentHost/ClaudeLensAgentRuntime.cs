using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class ClaudeLensAgentRuntime : ILensAgentRuntime
{
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private readonly Action<LensProviderEvent> _emit;
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
    private LensQuickSettingsSummary _quickSettings = new();
    private bool _assistantStreamEmitted;
    private bool _turnStarted;
    private bool _assistantMessageEmitted;
    private bool _interruptRequested;
    private long _sequence;

    public ClaudeLensAgentRuntime(Action<LensProviderEvent> emit)
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
                "request.resolve" => throw new InvalidOperationException("Claude Lens approval resolution is not supported by the current Claude runtime integration."),
                "user-input.resolve" => throw new InvalidOperationException("Claude Lens interview/user-input resolution is not supported by the current Claude runtime integration."),
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
        _quickSettings = CreateDefaultQuickSettings();
        if (!string.IsNullOrWhiteSpace(attach.ResumeThreadId))
        {
            _providerThreadId = attach.ResumeThreadId;
        }

        var events = new List<LensProviderEvent>
        {
            CreateEvent("session.started", null, null, null, "mtagenthost.claude", "runtime.attach", attach, lensEvent =>
            {
                lensEvent.SessionState = new LensProviderSessionStatePayload
                {
                    State = "starting",
                    StateLabel = "Starting",
                    Reason = "Claude Lens runtime attached."
                };
            }),
            CreateEvent("session.ready", null, null, null, "mtagenthost.claude", "runtime.attach", attach, lensEvent =>
            {
                lensEvent.SessionState = new LensProviderSessionStatePayload
                {
                    State = "ready",
                    StateLabel = "Ready",
                    Reason = "Claude Lens runtime is ready for the next turn."
                };
            }),
            CreateQuickSettingsUpdatedEvent(_quickSettings, "mtagenthost.claude", "runtime.attach", attach)
        };

        if (!string.IsNullOrWhiteSpace(_providerThreadId))
        {
            events.Add(CreateEvent("thread.started", null, null, null, "mtagenthost.claude", "runtime.attach", attach, lensEvent =>
            {
                lensEvent.ThreadState = new LensProviderThreadStatePayload
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
        if (_process is { HasExited: false } activeProcess)
        {
            await activeProcess.WaitForExitAsync(ct).ConfigureAwait(false);
        }

        if (_process is not null && (_process.HasExited || string.IsNullOrWhiteSpace(_activeTurnId)))
        {
            await DisposeProcessAsync(resetTurnState: false).ConfigureAwait(false);
        }

        if (_process is { HasExited: false })
        {
            throw new InvalidOperationException("Claude already has an active Lens turn.");
        }

        var request = command.StartTurn ?? throw new InvalidOperationException("turn.start payload is required.");
        var quickSettings = ResolveRequestedQuickSettings(request);
        var prompt = BuildPromptInput(request, quickSettings.PlanMode, out var addDirectories);
        if (string.IsNullOrWhiteSpace(prompt))
        {
            throw new InvalidOperationException("Lens turn input must include text or attachments.");
        }

        await DisposeProcessAsync().ConfigureAwait(false);

        _activeTurnId = "turn-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        _activeTurnModel = quickSettings.Model;
        _activeTurnEffort = quickSettings.Effort;
        _quickSettings = quickSettings;
        _assistantStreamEmitted = false;
        _turnStarted = false;
        _assistantMessageEmitted = false;
        _interruptRequested = false;
        _blocks.Clear();
        _tools.Clear();

        await StartClaudeProcessAsync(
            prompt,
            addDirectories,
            _activeTurnModel,
            _activeTurnEffort,
            _quickSettings.PermissionMode,
            ct).ConfigureAwait(false);

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
                    Status = "accepted",
                    QuickSettings = new LensQuickSettingsSummary
                    {
                        Model = _quickSettings.Model,
                        Effort = _quickSettings.Effort,
                        PlanMode = _quickSettings.PlanMode,
                        PermissionMode = _quickSettings.PermissionMode
                    }
                }
            },
            Events =
            [
                CreateQuickSettingsUpdatedEvent(_quickSettings, "midterm.lens", "turn.start", request)
            ]
        };
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
                    lensEvent.TurnCompleted = new LensProviderTurnCompletedPayload
                    {
                        State = "interrupted",
                        StateLabel = "Interrupted",
                        StopReason = "interrupt"
                    };
                }),
                CreateEvent("session.state.changed", turnId, null, null, "mtagenthost.claude", "turn.interrupt", command.InterruptTurn, lensEvent =>
                {
                    lensEvent.SessionState = new LensProviderSessionStatePayload
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
            while (!ct.IsCancellationRequested && _output is not null)
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
            while (!ct.IsCancellationRequested && _error is not null)
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
            await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        }
        catch
        {
        }

        if (!_interruptRequested && !string.IsNullOrWhiteSpace(_activeTurnId) && process.ExitCode != 0)
        {
            _emit(CreateEvent("turn.completed", _activeTurnId, null, null, "claude.stream-json", "process.exit", new { exitCode = process.ExitCode }, lensEvent =>
            {
                lensEvent.TurnCompleted = new LensProviderTurnCompletedPayload
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
                        lensEvent.SessionState = new LensProviderSessionStatePayload
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
                            lensEvent.TurnStarted = new LensProviderTurnStartedPayload
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
            lensEvent.Item = new LensProviderItemPayload
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
                        lensEvent.ContentDelta = new LensProviderContentDeltaPayload
                        {
                            StreamKind = "reasoning_text",
                            Delta = delta
                        };
                    }, rawLine));
                }
                else
                {
                    EmitAssistantDelta(delta, root, rawLine);
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
                        lensEvent.Item = new LensProviderItemPayload
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

        EmitAssistantMessage(text, root, rawLine);
    }

    private void EmitAssistantMessage(string text, JsonElement root, string rawLine)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(_activeTurnId))
        {
            return;
        }

        if (!_assistantStreamEmitted)
        {
            EmitAssistantDelta(text, root, rawLine);
        }

        _assistantMessageEmitted = true;
        var itemId = $"assistant:{_activeTurnId}";
        _emit(CreateEvent("item.completed", _activeTurnId, itemId, null, "claude.stream-json", "assistant", root, lensEvent =>
        {
            lensEvent.Item = new LensProviderItemPayload
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

        using var toolResultItems = content.EnumerateArray();
        while (toolResultItems.MoveNext())
        {
            var item = toolResultItems.Current;
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
                    lensEvent.ContentDelta = new LensProviderContentDeltaPayload
                    {
                        StreamKind = "command_output",
                        Delta = resultText
                    };
                }, rawLine));
            }

            _emit(CreateEvent("item.completed", _activeTurnId, tool.ItemId, null, "claude.stream-json", "tool_result", root, lensEvent =>
            {
                lensEvent.Item = new LensProviderItemPayload
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
        if (!isError &&
            !_assistantMessageEmitted &&
            !string.IsNullOrWhiteSpace(resultText))
        {
            EmitAssistantMessage(resultText, root, rawLine);
        }

        _emit(CreateEvent("turn.completed", _activeTurnId, null, null, "claude.stream-json", "result", root, lensEvent =>
        {
            lensEvent.TurnCompleted = new LensProviderTurnCompletedPayload
            {
                State = isError ? "failed" : "completed",
                StateLabel = isError ? "Failed" : "Completed",
                StopReason = subtype,
                ErrorMessage = isError ? resultText : null
            };
        }, rawLine));
        _emit(CreateEvent("session.state.changed", _activeTurnId, null, null, "claude.stream-json", "result", root, lensEvent =>
        {
            lensEvent.SessionState = new LensProviderSessionStatePayload
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
            lensEvent.ThreadState = new LensProviderThreadStatePayload
            {
                State = "active",
                StateLabel = "Active",
                ProviderThreadId = providerThreadId
            };
        }));
    }

    private void EmitAssistantDelta(string text, JsonElement root, string rawLine)
    {
        if (string.IsNullOrWhiteSpace(text) || string.IsNullOrWhiteSpace(_activeTurnId))
        {
            return;
        }

        _assistantStreamEmitted = true;
        var itemId = $"assistant:{_activeTurnId}";
        _emit(CreateEvent("content.delta", _activeTurnId, itemId, null, "claude.stream-json", "assistant", root, lensEvent =>
        {
            lensEvent.ContentDelta = new LensProviderContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = text
            };
        }, rawLine));
    }

    private void EmitRuntimeMessage(string eventType, string message, string? detail)
    {
        _emit(CreateEvent(eventType, _activeTurnId, null, null, "mtagenthost.claude", eventType, new { message, detail }, lensEvent =>
        {
            lensEvent.RuntimeMessage = new LensProviderRuntimeMessagePayload
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
        IReadOnlyList<LensProviderEvent>? events = null)
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

    private LensProviderEvent CreateEvent(
        string eventType,
        string? turnId,
        string? itemId,
        string? requestId,
        string source,
        string? method,
        object? payload,
        Action<LensProviderEvent>? configure = null,
        string? rawPayloadJson = null)
    {
        var lensEvent = new LensProviderEvent
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
            Raw = new LensProviderEventRaw
            {
                Source = source,
                Method = method,
                PayloadJson = rawPayloadJson ?? SerializePayload(payload)
            }
        };
        configure?.Invoke(lensEvent);
        return lensEvent;
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
        string permissionMode,
        CancellationToken ct)
    {
        var process = new Process
        {
            StartInfo = CreateProcessStartInfo(
                _binaryPath!,
                BuildArguments(model, effort, permissionMode, addDirectories),
                _workingDirectory!),
            EnableRaisingEvents = true
        };
        LensProviderRuntimeConfiguration.ApplyUserProfileEnvironment(process.StartInfo, _userProfileDirectory);
        LensProviderRuntimeConfiguration.ApplyEnvironmentVariables(process.StartInfo, Provider);
        if (!process.Start())
        {
            throw new InvalidOperationException("Claude process could not be started.");
        }

        AttachOwnedProcess(process);
        _readerTask = Task.Run(() => ReadLoopAsync(process, CancellationToken.None), CancellationToken.None);
        _errorTask = Task.Run(() => ReadErrorLoopAsync(process, CancellationToken.None), CancellationToken.None);
        var input = _input ?? throw new InvalidOperationException("Claude process input stream is unavailable.");
        await input.WriteAsync(prompt.AsMemory(), ct).ConfigureAwait(false);
        await input.FlushAsync(ct).ConfigureAwait(false);
        input.Close();
    }

    private async Task DisposeProcessAsync(bool resetTurnState = true)
    {
        try
        {
            if (_process is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch
        {
        }

        DisposeOwnedProcessHandles();

        if (_readerTask is not null)
        {
            await Task.WhenAny(_readerTask, Task.Delay(250, CancellationToken.None)).ConfigureAwait(false);
        }

        if (_errorTask is not null)
        {
            await Task.WhenAny(_errorTask, Task.Delay(250, CancellationToken.None)).ConfigureAwait(false);
        }

        _readerTask = null;
        _errorTask = null;

        if (resetTurnState)
        {
            ResetTurnState();
        }
    }

    private void AttachOwnedProcess(Process process)
    {
        try { _input?.Dispose(); } catch { }
        try { _output?.Dispose(); } catch { }
        try { _error?.Dispose(); } catch { }
        try { _process?.Dispose(); } catch { }
        _process = null;
        _input = null;
        _output = null;
        _error = null;
        _process = process;
        _output = process.StandardOutput;
        _error = process.StandardError;
        _input = process.StandardInput;
    }

    private void DisposeOwnedProcessHandles()
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

    private static string BuildPromptInput(
        LensTurnRequest request,
        string? planMode,
        out List<string> addDirectories)
    {
        addDirectories = [];
        var text = LensQuickSettings.ApplyPlanModePrompt(request.Text, planMode);
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

    private string BuildArguments(
        string? model,
        string? effort,
        string permissionMode,
        IReadOnlyList<string> addDirectories)
    {
        var args = new List<string>
        {
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            "--include-partial-messages"
        };

        if (string.Equals(
                LensQuickSettings.NormalizePermissionMode(permissionMode),
                LensQuickSettings.PermissionModeAuto,
                StringComparison.Ordinal))
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

    private LensQuickSettingsSummary CreateDefaultQuickSettings()
    {
        var defaultPermissionMode = LensProviderRuntimeConfiguration.GetClaudeDangerouslySkipPermissionsDefault()
            ? LensQuickSettings.PermissionModeAuto
            : LensQuickSettings.PermissionModeManual;
        return LensQuickSettings.CreateSummary(
            LensProviderRuntimeConfiguration.GetClaudeDefaultModel(),
            null,
            LensQuickSettings.PlanModeOff,
            defaultPermissionMode,
            defaultPermissionMode);
    }

    private LensQuickSettingsSummary ResolveRequestedQuickSettings(LensTurnRequest request)
    {
        var defaultPermissionMode = LensProviderRuntimeConfiguration.GetClaudeDangerouslySkipPermissionsDefault()
            ? LensQuickSettings.PermissionModeAuto
            : LensQuickSettings.PermissionModeManual;
        return LensQuickSettings.CreateSummary(
            request.Model ?? LensProviderRuntimeConfiguration.GetClaudeDefaultModel(),
            request.Effort,
            request.PlanMode,
            request.PermissionMode,
            defaultPermissionMode);
    }

    private LensProviderEvent CreateQuickSettingsUpdatedEvent(
        LensQuickSettingsSummary quickSettings,
        string source,
        string? method,
        object? payload)
    {
        var rawPayload = SerializeQuickSettingsRawPayload(payload);
        return CreateEvent("quick-settings.updated", null, null, null, source, method, rawPayload, lensEvent =>
        {
            lensEvent.QuickSettingsUpdated = LensQuickSettings.ToPayload(quickSettings);
        });
    }

    private static JsonElement SerializeQuickSettingsRawPayload(object? payload)
    {
        return payload switch
        {
            null => default,
            JsonElement element => element,
            LensAttachRuntimeRequest attach => JsonSerializer.SerializeToElement(
                attach,
                LensHostJsonContext.Default.LensAttachRuntimeRequest),
            LensTurnRequest request => JsonSerializer.SerializeToElement(
                request,
                LensHostJsonContext.Default.LensTurnRequest),
            _ => default
        };
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
        using var textItems = content.EnumerateArray();
        while (textItems.MoveNext())
        {
            var item = textItems.Current;
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
                JsonValueKind.Array => JoinContentArrayText(content),
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

    private static string JoinContentArrayText(JsonElement content)
    {
        var values = new List<string>();
        using var contentItems = content.EnumerateArray();
        while (contentItems.MoveNext())
        {
            var part = contentItems.Current;
            var value = GetString(part, "text") ?? part.ToString();
            if (!string.IsNullOrWhiteSpace(value))
            {
                values.Add(value);
            }
        }

        return string.Join(Environment.NewLine, values);
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

            if (extension.Equals(".ps1", StringComparison.OrdinalIgnoreCase))
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = "pwsh",
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
                startInfo.ArgumentList.Add("-NoLogo");
                startInfo.ArgumentList.Add("-NoProfile");
                startInfo.ArgumentList.Add("-ExecutionPolicy");
                startInfo.ArgumentList.Add("Bypass");
                startInfo.ArgumentList.Add("-File");
                startInfo.ArgumentList.Add(binaryPath);
                foreach (var argument in arguments.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    startInfo.ArgumentList.Add(argument);
                }

                return startInfo;
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
        _assistantStreamEmitted = false;
        _turnStarted = false;
        _assistantMessageEmitted = false;
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

}









