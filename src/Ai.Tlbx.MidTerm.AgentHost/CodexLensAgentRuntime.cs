using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class CodexLensAgentRuntime : ILensAgentRuntime
{
    private const int MaxInlineImageBytes = 10 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);
    private static readonly HashSet<string> SupportedApprovalDecisions = new(StringComparer.Ordinal)
    {
        "accept",
        "acceptForSession",
        "decline",
        "cancel"
    };

    private readonly Action<LensHostEventEnvelope> _emit;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonRpcReply>> _pendingRequests = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PendingCodexApproval> _pendingApprovals = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PendingCodexUserInput> _pendingUserInputs = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _shutdown = new();
    private ClientWebSocket? _webSocket;
    private Process? _process;
    private StreamReader? _output;
    private StreamReader? _error;
    private StreamWriter? _input;
    private Task? _readerTask;
    private Task? _errorTask;
    private string? _sessionId;
    private string? _workingDirectory;
    private string? _providerThreadId;
    private string? _activeTurnId;
    private string? _remoteEndpoint;
    private LensQuickSettingsSummary _quickSettings = new();
    private long _sequence;
    private int _nextRequestId;

    public CodexLensAgentRuntime(Action<LensHostEventEnvelope> emit)
    {
        _emit = emit;
    }

    public string Provider => "codex";

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();

        foreach (var pending in _pendingRequests.Values)
        {
            pending.TrySetException(new InvalidOperationException("Codex Lens runtime is shutting down."));
        }

        _pendingRequests.Clear();

        try
        {
            if (_webSocket is not null)
            {
                try
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "shutdown", CancellationToken.None).ConfigureAwait(false);
                }
                catch
                {
                }

                _webSocket.Dispose();
                _webSocket = null;
            }

            if (_process is { HasExited: false } process)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
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
            await Task.WhenAny(_readerTask, Task.Delay(250, CancellationToken.None)).ConfigureAwait(false);
        }

        if (_errorTask is not null)
        {
            await Task.WhenAny(_errorTask, Task.Delay(250, CancellationToken.None)).ConfigureAwait(false);
        }

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
                "runtime.attach" => await AttachAsync(command, ct).ConfigureAwait(false),
                "turn.start" => await StartTurnAsync(command, ct).ConfigureAwait(false),
                "turn.interrupt" => await InterruptTurnAsync(command, ct).ConfigureAwait(false),
                "request.resolve" => await ResolveRequestAsync(command, ct).ConfigureAwait(false),
                "user-input.resolve" => await ResolveUserInputAsync(command, ct).ConfigureAwait(false),
                _ => throw new InvalidOperationException($"Unsupported Codex command '{command.Type}'.")
            };
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<HostCommandOutcome> AttachAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        var attach = command.AttachRuntime ?? throw new InvalidOperationException("runtime.attach payload is required.");
        if (!string.Equals(attach.Provider, Provider, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Codex runtime cannot attach provider '{attach.Provider}'.");
        }

        if (string.IsNullOrWhiteSpace(attach.WorkingDirectory) || !Directory.Exists(attach.WorkingDirectory))
        {
            throw new InvalidOperationException("Codex working directory is required.");
        }

        _sessionId = command.SessionId;
        _workingDirectory = attach.WorkingDirectory;
        var attachPoint = attach.AttachPoint;
        if (IsAttachSatisfied(attachPoint))
        {
            return Accepted(command.CommandId, command.SessionId);
        }

        await DisposeProcessAsync().ConfigureAwait(false);

        if (attachPoint is not null)
        {
            await ConnectRemoteAsync(attachPoint, ct).ConfigureAwait(false);
        }
        else
        {
            var binaryPath = string.IsNullOrWhiteSpace(attach.ExecutablePath)
                ? FindExecutableInPath("codex")
                : attach.ExecutablePath;
            if (binaryPath is null)
            {
                throw new InvalidOperationException("Codex CLI was not found on PATH.");
            }

            StartSpawnedProcess(binaryPath, attach.WorkingDirectory, attach.UserProfileDirectory);
        }

        _providerThreadId = null;
        _activeTurnId = null;
        _remoteEndpoint = attachPoint?.Endpoint;
        _quickSettings = CreateDefaultQuickSettings();
        _pendingApprovals.Clear();
        _pendingUserInputs.Clear();

        EmitSessionState(
            "session.started",
            "starting",
            "Starting",
            attachPoint is null
                ? "Starting Codex Lens runtime."
                : "Connecting Lens to the running Codex app-server.");
        _readerTask = Task.Run(() => ReadCodexLoopAsync(_shutdown.Token), CancellationToken.None);
        if (_error is not null)
        {
            _errorTask = Task.Run(() => ReadCodexErrorLoopAsync(_shutdown.Token), CancellationToken.None);
        }

        await SendCodexRequestAsync("initialize", BuildCodexInitializeRequest, ct).ConfigureAwait(false);
        await WriteCodexMessageAsync(BuildCodexInitializedNotification(), ct).ConfigureAwait(false);
        var (threadResult, providerThreadId, resumedExistingThread) = await OpenThreadAsync(
            attach,
            _quickSettings,
            ct).ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(providerThreadId))
        {
            throw new InvalidOperationException("Codex thread open did not return a thread id.");
        }

        _providerThreadId = providerThreadId;
        var events = new List<LensHostEventEnvelope>
        {
            CreateEvent("session.ready", null, null, null, "codex.app-server", "thread/start", threadResult, lensEvent =>
            {
                lensEvent.SessionState = new LensPulseSessionStatePayload
                {
                    State = "ready",
                    StateLabel = "Ready",
                    Reason = resumedExistingThread
                        ? "Lens attached to the running Codex thread."
                        : attachPoint is null
                            ? "Codex Lens runtime ready."
                            : "Lens connected to the running Codex app-server."
                };
            }),
            CreateEvent("thread.started", null, null, null, "codex.app-server", "thread/start", threadResult, lensEvent =>
            {
                lensEvent.ThreadState = new LensPulseThreadStatePayload
                {
                    State = "active",
                    StateLabel = "Active",
                    ProviderThreadId = providerThreadId
                };
            }),
            CreateQuickSettingsUpdatedEvent(_quickSettings, "midterm.lens", "runtime.attach", attach)
        };

        return Accepted(command.CommandId, command.SessionId, events: events);
    }

    private async Task<HostCommandOutcome> StartTurnAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        EnsureAttached();
        if (_pendingUserInputs.Count > 0)
        {
            throw new InvalidOperationException("Codex is waiting for structured user input. Resolve that request before starting another turn.");
        }

        if (_pendingApprovals.Count > 0)
        {
            throw new InvalidOperationException("Codex is waiting for approval. Resolve the pending request before starting another turn.");
        }

        var request = command.StartTurn ?? throw new InvalidOperationException("turn.start payload is required.");
        var quickSettings = ResolveRequestedQuickSettings(request);
        if (!string.Equals(
                _quickSettings.PermissionMode,
                quickSettings.PermissionMode,
                StringComparison.Ordinal))
        {
            await ReopenThreadAsync(quickSettings.PermissionMode, ct).ConfigureAwait(false);
        }

        var input = await CreateCodexTurnInputAsync(request, quickSettings.PlanMode, ct).ConfigureAwait(false);
        if (input.Count == 0)
        {
            throw new InvalidOperationException("Lens turn input must include text or attachments.");
        }

        var turnResult = await SendCodexRequestAsync(
            "turn/start",
            id => BuildCodexTurnStartRequest(id, _providerThreadId!, input, quickSettings.Model, quickSettings.Effort),
            ct).ConfigureAwait(false);

        _quickSettings = quickSettings;
        _activeTurnId = GetString(turnResult, "turn", "id");
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
                    ThreadId = _providerThreadId!,
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
        EnsureAttached();
        var turnId = string.IsNullOrWhiteSpace(command.InterruptTurn?.TurnId)
            ? _activeTurnId
            : command.InterruptTurn!.TurnId;
        if (string.IsNullOrWhiteSpace(turnId))
        {
            throw new InvalidOperationException("Codex does not have an active turn to interrupt.");
        }

        await SendCodexRequestAsync(
            "turn/interrupt",
            id => BuildCodexTurnInterruptRequest(id, _providerThreadId!, turnId),
            ct).ConfigureAwait(false);

        return Accepted(
            command.CommandId,
            command.SessionId,
            accepted: new LensCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                TurnId = turnId
            });
    }

    private async Task<HostCommandOutcome> ResolveRequestAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        var resolution = command.ResolveRequest ?? throw new InvalidOperationException("request.resolve payload is required.");
        var requestId = resolution.RequestId;
        if (!_pendingApprovals.TryRemove(requestId, out var pending))
        {
            throw new InvalidOperationException($"Unknown pending approval request: {requestId}");
        }

        var decision = NormalizeApprovalDecision(resolution.Decision);
        await WriteCodexMessageAsync(BuildCodexApprovalResponse(pending.JsonRpcId, decision), ct).ConfigureAwait(false);

        return Accepted(
            command.CommandId,
            command.SessionId,
            accepted: new LensCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                RequestId = requestId
            },
            events:
            [
                CreateEvent("request.resolved", pending.TurnId, pending.ItemId, requestId, "midterm.lens", "item/requestApproval/decision", default, lensEvent =>
                {
                    lensEvent.RequestResolved = new LensPulseRequestResolvedPayload
                    {
                        RequestType = pending.RequestType,
                        Decision = decision
                    };
                })
            ]);
    }

    private async Task<HostCommandOutcome> ResolveUserInputAsync(LensHostCommandEnvelope command, CancellationToken ct)
    {
        var resolution = command.ResolveUserInput ?? throw new InvalidOperationException("user-input.resolve payload is required.");
        if (!_pendingUserInputs.TryRemove(resolution.RequestId, out var pending))
        {
            throw new InvalidOperationException($"Unknown pending user-input request: {resolution.RequestId}");
        }

        var answers = ToCodexQuestionAnswers(pending, resolution.Answers);
        await WriteCodexMessageAsync(BuildCodexUserInputResponse(pending.JsonRpcId, answers), ct).ConfigureAwait(false);

        return Accepted(
            command.CommandId,
            command.SessionId,
            accepted: new LensCommandAcceptedResponse
            {
                SessionId = command.SessionId,
                Status = "accepted",
                RequestId = resolution.RequestId
            },
            events:
            [
                CreateEvent("user-input.resolved", pending.TurnId, pending.ItemId, resolution.RequestId, "midterm.lens", "item/tool/requestUserInput/answered", default, lensEvent =>
                {
                    lensEvent.UserInputResolved = new LensPulseUserInputResolvedPayload
                    {
                        Answers = answers.Select(pair => new LensPulseAnsweredQuestion
                        {
                            QuestionId = pair.Key,
                            Answers = [.. pair.Value.Answers]
                        }).ToList()
                    };
                })
            ]);
    }

    private async Task ReadCodexLoopAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && HasActiveTransport())
            {
                string? line;
                if (_webSocket is not null)
                {
                    line = await ReadWebSocketMessageAsync(_webSocket, ct).ConfigureAwait(false);
                }
                else
                {
                    if (_process is not { HasExited: false } || _output is null)
                    {
                        break;
                    }

                    line = await _output.ReadLineAsync(ct).ConfigureAwait(false);
                }

                if (line is null)
                {
                    break;
                }

                HandleCodexLine(line);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            EmitRuntimeMessage("runtime.error", "Codex Lens stream failed.", ex.Message);
        }
    }

    private async Task ReadCodexErrorLoopAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested && _process is { HasExited: false })
            {
                var line = await _error!.ReadLineAsync(ct).ConfigureAwait(false);
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
    }

    private void HandleCodexLine(string line)
    {
        using var document = JsonDocument.Parse(line);
        var root = document.RootElement;

        if (root.TryGetProperty("id", out var idElement) &&
            (root.TryGetProperty("result", out var resultElement) || root.TryGetProperty("error", out _)))
        {
            var id = idElement.ToString();
            if (_pendingRequests.TryRemove(id, out var pending))
            {
                if (root.TryGetProperty("error", out var errorElement))
                {
                    pending.TrySetResult(new JsonRpcReply
                    {
                        IsError = true,
                        ErrorMessage = GetString(errorElement, "message") ?? errorElement.ToString()
                    });
                }
                else
                {
                    pending.TrySetResult(new JsonRpcReply
                    {
                        Payload = resultElement.Clone()
                    });
                }
            }

            return;
        }

        if (!root.TryGetProperty("method", out var methodElement) || methodElement.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var method = methodElement.GetString() ?? string.Empty;
        var payload = root.TryGetProperty("params", out var paramsElement)
            ? paramsElement.Clone()
            : default;

        if (root.TryGetProperty("id", out var requestIdElement))
        {
            HandleCodexServerRequest(method, requestIdElement.ToString(), payload);
            return;
        }

        HandleCodexNotification(method, payload);
    }

    private void HandleCodexServerRequest(string method, string jsonRpcId, JsonElement payload)
    {
        if (method == "item/tool/requestUserInput")
        {
            var turnId = ResolveTurnId(payload);
            var itemId = ResolveItemId(payload);
            var requestId = "ui-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
            var questions = ReadCodexQuestions(payload);
            var questionIds = ReadCodexQuestionIds(payload);
            var summary = ReadCodexQuestionSummary(payload);
            _pendingUserInputs[requestId] = new PendingCodexUserInput
            {
                RequestId = requestId,
                JsonRpcId = jsonRpcId,
                TurnId = turnId,
                ItemId = itemId,
                QuestionIds = questionIds,
                Summary = summary,
                CreatedAt = DateTimeOffset.UtcNow
            };

            _emit(CreateEvent("user-input.requested", turnId, itemId, requestId, "codex.app-server.request", method, payload, lensEvent =>
            {
                lensEvent.UserInputRequested = new LensPulseUserInputRequestedPayload
                {
                    Questions = questions
                };
            }));
            return;
        }

        if (method.Contains("requestApproval", StringComparison.OrdinalIgnoreCase))
        {
            var turnId = ResolveTurnId(payload);
            var itemId = ResolveItemId(payload);
            var requestId = "approval-" + jsonRpcId;
            var requestType = method.Contains("commandExecution", StringComparison.OrdinalIgnoreCase)
                ? "command_execution_approval"
                : method.Contains("fileRead", StringComparison.OrdinalIgnoreCase)
                    ? "file_read_approval"
                    : "file_change_approval";
            var requestTypeLabel = HumanizeRequestType(requestType);
            var detail = BuildCodexItemDetail(payload);
            _pendingApprovals[requestId] = new PendingCodexApproval
            {
                RequestId = requestId,
                JsonRpcId = jsonRpcId,
                RequestType = requestType,
                RequestTypeLabel = requestTypeLabel,
                TurnId = turnId,
                ItemId = itemId,
                Detail = detail
            };

            _emit(CreateEvent("request.opened", turnId, itemId, requestId, "codex.app-server.request", method, payload, lensEvent =>
            {
                lensEvent.RequestOpened = new LensPulseRequestOpenedPayload
                {
                    RequestType = requestType,
                    RequestTypeLabel = requestTypeLabel,
                    Detail = detail
                };
            }));
            return;
        }

        _ = WriteCodexMessageAsync(BuildCodexUnsupportedRequestResponse(jsonRpcId, method), CancellationToken.None);
    }

    private void HandleCodexNotification(string method, JsonElement payload)
    {
        switch (method)
        {
            case "thread/started":
            {
                var providerThreadId = GetString(payload, "thread", "id") ?? GetString(payload, "threadId");
                if (!string.IsNullOrWhiteSpace(providerThreadId))
                {
                    _providerThreadId = providerThreadId;
                }

                _emit(CreateEvent("thread.started", null, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.ThreadState = new LensPulseThreadStatePayload
                    {
                        State = "active",
                        StateLabel = "Active",
                        ProviderThreadId = providerThreadId
                    };
                }));
                break;
            }

            case "thread/status/changed":
            case "thread/archived":
            case "thread/unarchived":
            case "thread/closed":
            case "thread/compacted":
            {
                var providerThreadId = GetString(payload, "thread", "id") ?? GetString(payload, "threadId") ?? _providerThreadId;
                if (!string.IsNullOrWhiteSpace(providerThreadId))
                {
                    _providerThreadId = providerThreadId;
                }

                var threadState = ResolveCodexThreadState(method, payload);
                _emit(CreateEvent("thread.state.changed", null, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.ThreadState = new LensPulseThreadStatePayload
                    {
                        State = threadState.State,
                        StateLabel = threadState.StateLabel,
                        ProviderThreadId = providerThreadId
                    };
                    if (!string.IsNullOrWhiteSpace(threadState.Detail))
                    {
                        lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                        {
                            Message = threadState.Message,
                            Detail = threadState.Detail
                        };
                    }
                }));
                break;
            }

            case "thread/name/updated":
            {
                var threadName = GetString(payload, "threadName") ?? GetString(payload, "thread", "name");
                _emit(CreateEvent("thread.metadata.updated", null, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = "Codex thread metadata updated.",
                        Detail = string.IsNullOrWhiteSpace(threadName) ? "The thread metadata changed." : $"Renamed to {threadName.Trim()}."
                    };
                }));
                break;
            }

            case "thread/tokenUsage/updated":
            {
                var detail = BuildCodexTokenUsageDetail(payload);
                _emit(CreateEvent("thread.token-usage.updated", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = "Codex context window updated.",
                        Detail = detail
                    };
                }));
                break;
            }

            case "turn/started":
            {
                var turnId = ResolveTurnId(payload);
                _activeTurnId = turnId;
                _emit(CreateEvent("session.state.changed", turnId, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.SessionState = new LensPulseSessionStatePayload
                    {
                        State = "running",
                        StateLabel = "Running",
                        Reason = "Codex turn started."
                    };
                }));
                _emit(CreateEvent("turn.started", turnId, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.TurnStarted = new LensPulseTurnStartedPayload
                    {
                        Model = GetString(payload, "turn", "model"),
                        Effort = GetString(payload, "turn", "effort")
                    };
                }));
                break;
            }

            case "turn/completed":
            {
                var turnState = GetString(payload, "turn", "status") ?? "completed";
                var errorMessage = GetString(payload, "turn", "error", "message");
                var turnId = ResolveTurnId(payload);
                if (string.IsNullOrWhiteSpace(turnId) || string.Equals(_activeTurnId, turnId, StringComparison.Ordinal))
                {
                    _activeTurnId = null;
                }

                _emit(CreateEvent("turn.completed", turnId, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.TurnCompleted = new LensPulseTurnCompletedPayload
                    {
                        State = turnState,
                        StateLabel = HumanizeTurnState(turnState),
                        ErrorMessage = errorMessage
                    };
                }));
                _emit(CreateEvent("session.state.changed", turnId, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.SessionState = new LensPulseSessionStatePayload
                    {
                        State = string.Equals(turnState, "failed", StringComparison.OrdinalIgnoreCase) ? "error" : "ready",
                        StateLabel = string.Equals(turnState, "failed", StringComparison.OrdinalIgnoreCase) ? "Error" : "Ready",
                        Reason = errorMessage ?? $"Codex turn {turnState}."
                    };
                }));
                break;
            }

            case "turn/aborted":
            {
                var turnId = ResolveTurnId(payload);
                if (string.IsNullOrWhiteSpace(turnId) || string.Equals(_activeTurnId, turnId, StringComparison.Ordinal))
                {
                    _activeTurnId = null;
                }

                _emit(CreateEvent("turn.aborted", turnId, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.TurnCompleted = new LensPulseTurnCompletedPayload
                    {
                        State = "interrupted",
                        StateLabel = "Interrupted",
                        StopReason = GetString(payload, "reason") ?? GetString(payload, "message")
                    };
                }));
                _emit(CreateEvent("session.state.changed", turnId, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.SessionState = new LensPulseSessionStatePayload
                    {
                        State = "ready",
                        StateLabel = "Ready",
                        Reason = "Codex turn aborted."
                    };
                }));
                break;
            }

            case "turn/plan/updated":
            {
                var planText = BuildCodexPlanMarkdown(payload);
                if (!string.IsNullOrWhiteSpace(planText))
                {
                    _emit(CreateEvent("plan.completed", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                    {
                        lensEvent.PlanCompleted = new LensPulsePlanCompletedPayload
                        {
                            PlanMarkdown = planText
                        };
                    }));
                }
                break;
            }

            case "turn/diff/updated":
            {
                var diff = GetString(payload, "unifiedDiff") ?? GetString(payload, "diff") ?? GetString(payload, "patch") ?? string.Empty;
                _emit(CreateEvent("diff.updated", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.DiffUpdated = new LensPulseDiffUpdatedPayload
                    {
                        UnifiedDiff = diff
                    };
                }));
                break;
            }

            case "item/agentMessage/delta":
                EmitContentDelta(method, payload, "assistant_text");
                break;

            case "item/reasoning/textDelta":
                EmitContentDelta(method, payload, "reasoning_text");
                break;

            case "item/reasoning/summaryTextDelta":
                EmitContentDelta(method, payload, "reasoning_summary_text");
                break;

            case "item/commandExecution/outputDelta":
                EmitContentDelta(method, payload, "command_output");
                break;

            case "item/fileChange/outputDelta":
                EmitContentDelta(method, payload, "file_change_output");
                break;

            case "item/plan/delta":
            {
                var delta = GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty;
                if (!string.IsNullOrWhiteSpace(delta))
                {
                    _emit(CreateEvent("plan.delta", ResolveTurnId(payload), ResolveItemId(payload), null, "codex.app-server.notification", method, payload, lensEvent =>
                    {
                        lensEvent.PlanDelta = new LensPulsePlanDeltaPayload
                        {
                            Delta = delta
                        };
                    }));
                }
                break;
            }

            case "item/started":
            {
                var turnId = ResolveTurnId(payload);
                var itemId = ResolveItemId(payload);
                var itemType = NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type"));
                _emit(CreateEvent("item.started", turnId, itemId, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.Item = new LensPulseItemPayload
                    {
                        ItemType = itemType,
                        Status = "in_progress",
                        Title = $"{PrettifyToolKind(itemType)} started",
                        Detail = BuildCodexItemDetail(payload)
                    };
                }));
                break;
            }

            case "item/reasoning/summaryPartAdded":
            case "item/commandExecution/terminalInteraction":
            {
                var turnId = ResolveTurnId(payload);
                var itemId = ResolveItemId(payload);
                var itemType = method == "item/commandExecution/terminalInteraction"
                    ? "command_execution"
                    : NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type"));
                var detail = method == "item/commandExecution/terminalInteraction"
                    ? GetString(payload, "stdin") ?? BuildCodexItemDetail(payload)
                    : BuildCodexItemDetail(payload);
                _emit(CreateEvent("item.updated", turnId, itemId, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.Item = new LensPulseItemPayload
                    {
                        ItemType = itemType,
                        Status = "in_progress",
                        Title = method == "item/commandExecution/terminalInteraction"
                            ? "Command running"
                            : PrettifyToolKind(itemType),
                        Detail = detail
                    };
                }));
                break;
            }

            case "item/mcpToolCall/progress":
            {
                var turnId = ResolveTurnId(payload);
                var itemId = ResolveItemId(payload) ?? GetString(payload, "toolUseId");
                if (string.IsNullOrWhiteSpace(itemId))
                {
                    break;
                }

                var itemType = NormalizeCodexItemType(
                    GetString(payload, "item", "type") ??
                    GetString(payload, "type") ??
                    "mcpToolCall");
                if (itemType == "user_message")
                {
                    break;
                }

                var title = GetString(payload, "toolName") ?? "MCP tool";
                var detail = GetString(payload, "summary") ?? BuildCodexItemDetail(payload);
                _emit(CreateEvent("item.updated", turnId, itemId, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.Item = new LensPulseItemPayload
                    {
                        ItemType = itemType,
                        Status = "in_progress",
                        Title = title,
                        Detail = detail
                    };
                }));
                break;
            }

            case "codex/event/task_started":
            {
                var turnId = ResolveTurnId(payload);
                var taskId = GetString(payload, "id") ?? turnId;
                if (string.IsNullOrWhiteSpace(taskId))
                {
                    break;
                }

                var taskType = GetString(payload, "msg", "collaboration_mode_kind");
                var itemType = ResolveCodexTaskItemType(taskType);
                var title = itemType == "plan" ? "Planning" : "Reasoning";
                var detail = GetString(payload, "msg", "text")
                             ?? GetString(payload, "msg", "summary")
                             ?? GetString(payload, "msg", "last_agent_message")
                             ?? "Codex started a task.";
                _emit(CreateEvent("item.started", turnId, taskId, null, "codex.eventmsg", method, payload, lensEvent =>
                {
                    lensEvent.Item = new LensPulseItemPayload
                    {
                        ItemType = itemType,
                        Status = "in_progress",
                        Title = title,
                        Detail = detail
                    };
                }));
                break;
            }

            case "codex/event/agent_reasoning":
            {
                var taskId = GetString(payload, "id") ?? ResolveTurnId(payload);
                var detail = GetString(payload, "msg", "text");
                if (string.IsNullOrWhiteSpace(taskId) || string.IsNullOrWhiteSpace(detail))
                {
                    break;
                }

                _emit(CreateEvent("item.updated", ResolveTurnId(payload), taskId, null, "codex.eventmsg", method, payload, lensEvent =>
                {
                    lensEvent.Item = new LensPulseItemPayload
                    {
                        ItemType = "reasoning",
                        Status = "in_progress",
                        Title = "Reasoning",
                        Detail = detail
                    };
                }));
                break;
            }

            case "codex/event/task_complete":
            {
                var turnId = ResolveTurnId(payload);
                var taskId = GetString(payload, "id") ?? turnId;
                var taskType = GetString(payload, "msg", "collaboration_mode_kind");
                var itemType = ResolveCodexTaskItemType(taskType);
                var summary = GetString(payload, "msg", "last_agent_message")
                              ?? GetString(payload, "msg", "text")
                              ?? "Codex completed a task.";
                if (!string.IsNullOrWhiteSpace(taskId))
                {
                    _emit(CreateEvent("item.completed", turnId, taskId, null, "codex.eventmsg", method, payload, lensEvent =>
                    {
                        lensEvent.Item = new LensPulseItemPayload
                        {
                            ItemType = itemType,
                            Status = "completed",
                            Title = itemType == "plan" ? "Plan completed" : "Reasoning completed",
                            Detail = summary
                        };
                    }));
                }

                var proposedPlan = ExtractProposedPlanMarkdown(summary);
                if (!string.IsNullOrWhiteSpace(proposedPlan))
                {
                    _emit(CreateEvent("plan.completed", turnId, taskId, null, "codex.eventmsg", method, payload, lensEvent =>
                    {
                        lensEvent.PlanCompleted = new LensPulsePlanCompletedPayload
                        {
                            PlanMarkdown = proposedPlan
                        };
                    }));
                }

                break;
            }

            case "codex/event/reasoning_content_delta":
            {
                var delta = GetString(payload, "msg", "delta");
                if (string.IsNullOrWhiteSpace(delta))
                {
                    break;
                }

                var streamKind = Traverse(payload, "msg", "summary_index") is JsonElement { ValueKind: JsonValueKind.Number }
                    ? "reasoning_summary_text"
                    : "reasoning_text";
                _emit(CreateEvent("content.delta", ResolveTurnId(payload), ResolveItemId(payload), null, "codex.eventmsg", method, payload, lensEvent =>
                {
                    lensEvent.ContentDelta = new LensPulseContentDeltaPayload
                    {
                        StreamKind = streamKind,
                        Delta = delta
                    };
                }));
                break;
            }

            case "item/completed":
            {
                var turnId = ResolveTurnId(payload);
                var itemId = ResolveItemId(payload);
                var itemType = NormalizeCodexItemType(GetString(payload, "item", "type") ?? GetString(payload, "type"));
                if (itemType == "user_message")
                {
                    break;
                }

                if (itemType == "plan")
                {
                    var detail = BuildCodexItemDetail(payload);
                    if (!string.IsNullOrWhiteSpace(detail))
                    {
                        _emit(CreateEvent("plan.completed", turnId, itemId, null, "codex.app-server.notification", method, payload, lensEvent =>
                        {
                            lensEvent.PlanCompleted = new LensPulsePlanCompletedPayload
                            {
                                PlanMarkdown = detail
                            };
                        }));
                    }

                    break;
                }

                var title = itemType is "assistant_message" or "agent_message"
                    ? "Assistant message"
                    : $"{PrettifyToolKind(itemType)} completed";
                _emit(CreateEvent("item.completed", turnId, itemId, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.Item = new LensPulseItemPayload
                    {
                        ItemType = itemType is "agent_message" ? "assistant_message" : itemType,
                        Status = "completed",
                        Title = title,
                        Detail = BuildCodexItemDetail(payload)
                    };
                }));
                break;
            }

            case "model/rerouted":
            {
                var fromModel = GetString(payload, "fromModel") ?? "unknown";
                var toModel = GetString(payload, "toModel") ?? "unknown";
                var reason = GetString(payload, "reason");
                _emit(CreateEvent("model.rerouted", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = $"Codex rerouted the model from {fromModel} to {toModel}.",
                        Detail = reason
                    };
                }));
                break;
            }

            case "deprecationNotice":
            {
                _emit(CreateEvent("deprecation.notice", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = GetString(payload, "summary") ?? "Codex reported a deprecation notice.",
                        Detail = GetString(payload, "details")
                    };
                }));
                break;
            }

            case "configWarning":
            {
                _emit(CreateEvent("config.warning", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = GetString(payload, "summary") ?? "Codex reported a configuration warning.",
                        Detail = JoinNonEmpty(
                            GetString(payload, "details"),
                            GetString(payload, "path"))
                    };
                }));
                break;
            }

            case "account/updated":
            {
                _emit(CreateEvent("account.updated", null, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = "Codex account details updated.",
                        Detail = BuildCompactJsonDetail(payload)
                    };
                }));
                break;
            }

            case "account/rateLimits/updated":
            {
                _emit(CreateEvent("account.rate-limits.updated", null, null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = "Codex rate limits updated.",
                        Detail = BuildCompactJsonDetail(payload)
                    };
                }));
                break;
            }

            case "mcpServer/oauthLogin/completed":
            {
                var success = GetBoolean(payload, "success");
                var name = GetString(payload, "name");
                var error = GetString(payload, "error");
                _emit(CreateEvent("mcp.oauth.completed", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = success ? "MCP sign-in completed." : "MCP sign-in failed.",
                        Detail = JoinNonEmpty(name, error)
                    };
                }));
                break;
            }

            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/outputAudio/delta":
            case "thread/realtime/error":
            case "thread/realtime/closed":
            {
                _emit(CreateEvent(MapRealtimeEventType(method), ResolveTurnId(payload), ResolveItemId(payload), null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = HumanizeRealtimeEvent(method),
                        Detail = BuildCompactJsonDetail(payload)
                    };
                }));
                break;
            }

            case "error":
            {
                var message = GetString(payload, "error", "message") ?? "Codex runtime error";
                var willRetry = GetBoolean(payload, "willRetry");
                _emit(CreateEvent(willRetry ? "runtime.warning" : "runtime.error", ResolveTurnId(payload), null, null, "codex.app-server.notification", method, payload, lensEvent =>
                {
                    lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
                    {
                        Message = message,
                        Detail = willRetry ? "Codex reported that it will retry." : message
                    };
                }));
                break;
            }

            default:
                EmitUnknownCodexNotificationFallback(method, payload);
                break;
        }
    }

    private void EmitContentDelta(string method, JsonElement payload, string streamKind)
    {
        var delta = GetString(payload, "delta") ?? GetString(payload, "text") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(delta))
        {
            return;
        }

        _emit(CreateEvent("content.delta", ResolveTurnId(payload), ResolveItemId(payload), null, "codex.app-server.notification", method, payload, lensEvent =>
        {
            lensEvent.ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = streamKind,
                Delta = delta
            };
        }));
    }

    private void EmitUnknownCodexNotificationFallback(string method, JsonElement payload)
    {
        _emit(CreateEvent(
            "item.updated",
            ResolveUnknownCodexTurnId(payload),
            null,
            null,
            method.StartsWith("codex/event/", StringComparison.Ordinal)
                ? "codex.eventmsg"
                : "codex.app-server.notification",
            method,
            payload,
            lensEvent =>
            {
                lensEvent.Item = new LensPulseItemPayload
                {
                    ItemType = "unknown_agent_message",
                    Status = "completed",
                    Title = "Unknown agent message",
                    Detail = BuildUnknownCodexFallbackDetail(method, payload)
                };
            }));
    }

    private string? ResolveUnknownCodexTurnId(JsonElement payload)
    {
        return ResolveTurnId(payload)
               ?? GetString(payload, "msg", "turn_id")
               ?? GetString(payload, "msg", "turnId");
    }

    private static string BuildUnknownCodexFallbackDetail(string method, JsonElement payload)
    {
        var rawPayload = BuildCompactJsonDetail(payload);
        return string.IsNullOrWhiteSpace(rawPayload)
            ? $"Method: {method}"
            : $"Method: {method}\n{rawPayload}";
    }

    private string? ResolveTurnId(JsonElement payload, string? fallbackTurnId = null)
    {
        return GetString(payload, "turnId")
               ?? GetString(payload, "turn", "id")
               ?? GetString(payload, "item", "turnId")
               ?? GetString(payload, "item", "turn", "id")
               ?? fallbackTurnId
               ?? _activeTurnId;
    }

    private static string? ResolveItemId(JsonElement payload)
    {
        return GetString(payload, "itemId")
               ?? GetString(payload, "item", "id");
    }

    private void EmitSessionState(string eventType, string state, string stateLabel, string? reason)
    {
        _emit(CreateEvent(eventType, null, null, null, "mtagenthost.codex", eventType, default, lensEvent =>
        {
            lensEvent.SessionState = new LensPulseSessionStatePayload
            {
                State = state,
                StateLabel = stateLabel,
                Reason = reason
            };
        }));
    }

    private void EmitRuntimeMessage(string eventType, string message, string? detail)
    {
        _emit(CreateEvent(eventType, _activeTurnId, null, null, "mtagenthost.codex", eventType, default, lensEvent =>
        {
            lensEvent.RuntimeMessage = new LensPulseRuntimeMessagePayload
            {
                Message = message,
                Detail = detail
            };
        }));
    }

    private LensHostEventEnvelope CreateEvent(
        string type,
        string? turnId,
        string? itemId,
        string? requestId,
        string rawSource,
        string? rawMethod,
        JsonElement payload,
        Action<LensPulseEvent> configure)
    {
        var nextSequence = Interlocked.Increment(ref _sequence);
        var lensEvent = new LensPulseEvent
        {
            Sequence = nextSequence,
            EventId = "lens-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture),
            SessionId = _sessionId ?? string.Empty,
            Provider = Provider,
            ThreadId = _providerThreadId ?? _sessionId ?? string.Empty,
            TurnId = turnId,
            ItemId = itemId,
            RequestId = requestId,
            CreatedAt = DateTimeOffset.UtcNow,
            Type = type,
            Raw = new LensPulseEventRaw
            {
                Source = rawSource,
                Method = rawMethod,
                PayloadJson = payload.ValueKind == JsonValueKind.Undefined ? null : payload.GetRawText()
            }
        };

        configure(lensEvent);
        return new LensHostEventEnvelope
        {
            SessionId = _sessionId ?? string.Empty,
            Event = lensEvent
        };
    }

    private void EnsureAttached()
    {
        if (!HasActiveTransport() || string.IsNullOrWhiteSpace(_providerThreadId))
        {
            throw new InvalidOperationException("Codex Lens runtime is not attached.");
        }
    }

    private async Task<JsonElement> SendCodexRequestAsync(
        string method,
        Func<string, string> messageFactory,
        CancellationToken ct)
    {
        var id = Interlocked.Increment(ref _nextRequestId).ToString(CultureInfo.InvariantCulture);
        var pending = new TaskCompletionSource<JsonRpcReply>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pendingRequests[id] = pending;

        await WriteCodexMessageAsync(messageFactory(id), ct).ConfigureAwait(false);

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct, _shutdown.Token);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(20));
        await using var _ = timeoutCts.Token.Register(() => pending.TrySetCanceled(timeoutCts.Token));
        var reply = await pending.Task.ConfigureAwait(false);
        if (reply.IsError)
        {
            throw new InvalidOperationException(reply.ErrorMessage ?? $"{method} failed.");
        }

        return reply.Payload;
    }

    private async Task WriteCodexMessageAsync(string payload, CancellationToken ct)
    {
        EnsureAttachedOrStarting();
        if (_webSocket is not null)
        {
            var bytes = Utf8NoBom.GetBytes(payload);
            await _webSocket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
            return;
        }

        await _input!.WriteLineAsync(payload.AsMemory(), ct).ConfigureAwait(false);
        await _input.FlushAsync(ct).ConfigureAwait(false);
    }

    private void EnsureAttachedOrStarting()
    {
        if (!HasActiveTransport())
        {
            throw new InvalidOperationException("Codex Lens runtime is not attached.");
        }
    }

    private async Task DisposeProcessAsync()
    {
        try
        {
            if (_webSocket is not null)
            {
                try
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "detach", CancellationToken.None).ConfigureAwait(false);
                }
                catch
                {
                }

                _webSocket.Dispose();
            }

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
        DisposeOwnedWebSocket();
        _readerTask = null;
        _errorTask = null;
        _remoteEndpoint = null;
    }

    private bool HasActiveTransport()
    {
        return _webSocket is { State: WebSocketState.Open } ||
               (_process is { HasExited: false } && _input is not null);
    }

    private void AttachOwnedWebSocket(ClientWebSocket webSocket)
    {
        try { _webSocket?.Dispose(); } catch { }
        _webSocket = null;
        _webSocket = webSocket;
    }

    private void DisposeOwnedWebSocket()
    {
        try { _webSocket?.Dispose(); } catch { }
        _webSocket = null;
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

    private bool IsAttachSatisfied(SessionAgentAttachPoint? attachPoint)
    {
        if (string.IsNullOrWhiteSpace(_providerThreadId))
        {
            return false;
        }

        if (attachPoint is not null)
        {
            return _webSocket is { State: WebSocketState.Open } &&
                   string.Equals(_remoteEndpoint, attachPoint.Endpoint, StringComparison.OrdinalIgnoreCase);
        }

        return _process is { HasExited: false } && _input is not null;
    }

    private async Task ConnectRemoteAsync(SessionAgentAttachPoint attachPoint, CancellationToken ct)
    {
        if (!string.Equals(attachPoint.Provider, Provider, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Codex runtime cannot attach provider '{attachPoint.Provider}'.");
        }

        if (!string.Equals(attachPoint.TransportKind, SessionAgentAttachPoint.CodexAppServerWebSocketTransport, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Unsupported Codex attach transport '{attachPoint.TransportKind}'.");
        }

        if (!Uri.TryCreate(attachPoint.Endpoint, UriKind.Absolute, out var endpoint) ||
            (endpoint.Scheme != Uri.UriSchemeWs && endpoint.Scheme != Uri.UriSchemeWss))
        {
            throw new InvalidOperationException("Codex websocket attach endpoint is invalid.");
        }

        var webSocket = new ClientWebSocket();
        await webSocket.ConnectAsync(endpoint, ct).ConfigureAwait(false);
        AttachOwnedWebSocket(webSocket);
    }

    private void StartSpawnedProcess(string binaryPath, string workingDirectory, string? userProfileDirectory)
    {
        var process = new Process
        {
            StartInfo = CreateProcessStartInfo(binaryPath, "app-server", workingDirectory),
            EnableRaisingEvents = true
        };
        LensProviderRuntimeConfiguration.ApplyUserProfileEnvironment(process.StartInfo, userProfileDirectory);
        LensProviderRuntimeConfiguration.ApplyEnvironmentVariables(process.StartInfo, Provider);

        if (!process.Start())
        {
            throw new InvalidOperationException("Codex app-server could not be started.");
        }

        AttachOwnedProcess(process);
        process.Exited += (_, _) =>
        {
            EmitRuntimeMessage(
                "session.exited",
                "Codex Lens runtime exited.",
                $"Exit code {process.ExitCode.ToString(CultureInfo.InvariantCulture)}.");
        };
    }

    private async Task<(JsonElement ThreadResult, string? ProviderThreadId, bool ResumedExistingThread)> OpenThreadAsync(
        LensAttachRuntimeRequest attach,
        LensQuickSettingsSummary quickSettings,
        CancellationToken ct)
    {
        var resumeThreadId = attach.ResumeThreadId;
        if (string.IsNullOrWhiteSpace(resumeThreadId) && attach.AttachPoint?.SharedRuntime == true)
        {
            resumeThreadId = await TryResolvePreferredLoadedThreadIdAsync(ct).ConfigureAwait(false);
        }

        JsonElement threadResult;
        bool resumedExistingThread;
        if (!string.IsNullOrWhiteSpace(resumeThreadId))
        {
            threadResult = await SendCodexRequestAsync(
                "thread/resume",
                id => BuildCodexThreadResumeRequest(id, resumeThreadId, attach.WorkingDirectory, quickSettings.PermissionMode),
                ct).ConfigureAwait(false);
            resumedExistingThread = true;
        }
        else
        {
            threadResult = await SendCodexRequestAsync(
                "thread/start",
                id => BuildCodexThreadStartRequest(id, attach.WorkingDirectory, quickSettings.PermissionMode),
                ct).ConfigureAwait(false);
            resumedExistingThread = false;
        }

        var providerThreadId = GetString(threadResult, "thread", "id") ?? GetString(threadResult, "threadId");
        return (threadResult, providerThreadId, resumedExistingThread);
    }

    private async Task<string?> TryResolvePreferredLoadedThreadIdAsync(CancellationToken ct)
    {
        var result = await SendCodexRequestAsync(
            "thread/loaded/list",
            BuildCodexThreadLoadedListRequest,
            ct).ConfigureAwait(false);
        if (!result.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var threadIds = new List<string>(capacity: 2);
        using (var threadItems = data.EnumerateArray())
        {
            while (threadItems.MoveNext() && threadIds.Count < 2)
            {
                var element = threadItems.Current;
                if (element.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                var value = element.GetString();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    threadIds.Add(value);
                }
            }
        }

        if (threadIds.Count > 1)
        {
            EmitRuntimeMessage(
                "runtime.warning",
                "Multiple loaded Codex threads were found on the attached app-server.",
                "Lens is resuming the first loaded thread because the terminal session did not expose a specific thread id.");
        }

        return threadIds.FirstOrDefault();
    }

    private static async Task<string?> ReadWebSocketMessageAsync(ClientWebSocket webSocket, CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(8192);
        try
        {
            using var message = new MemoryStream();
            while (true)
            {
                var result = await webSocket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return null;
                }

                if (result.Count > 0)
                {
                    await message.WriteAsync(buffer.AsMemory(0, result.Count), ct).ConfigureAwait(false);
                }

                if (result.EndOfMessage)
                {
                    break;
                }
            }

            return Utf8NoBom.GetString(message.GetBuffer(), 0, (int)message.Length);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static HostCommandOutcome Accepted(
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
                    Status = "accepted"
                }
            },
            Events = events ?? []
        };
    }

    private static string BuildCodexInitializeRequest(string id)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "initialize");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WritePropertyName("clientInfo");
            writer.WriteStartObject();
            writer.WriteString("name", "midterm");
            writer.WriteString("title", "MidTerm Lens");
            writer.WriteString("version", "dev");
            writer.WriteEndObject();
            writer.WritePropertyName("capabilities");
            writer.WriteStartObject();
            writer.WriteBoolean("experimentalApi", true);
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexInitializedNotification()
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", "initialized");
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexThreadStartRequest(string id, string cwd, string permissionMode)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "thread/start");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("cwd", cwd);
            writer.WriteString("approvalPolicy", ResolveCodexApprovalPolicy(permissionMode));
            writer.WriteString("sandbox", ResolveCodexSandbox(permissionMode));
            writer.WriteBoolean("experimentalRawEvents", false);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexThreadResumeRequest(
        string id,
        string threadId,
        string cwd,
        string permissionMode)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "thread/resume");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("threadId", threadId);
            writer.WriteString("cwd", cwd);
            writer.WriteString("approvalPolicy", ResolveCodexApprovalPolicy(permissionMode));
            writer.WriteString("sandbox", ResolveCodexSandbox(permissionMode));
            writer.WriteBoolean("persistExtendedHistory", false);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexThreadLoadedListRequest(string id)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "thread/loaded/list");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteNumber("limit", 8);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexTurnStartRequest(
        string id,
        string threadId,
        IReadOnlyList<CodexTurnInputEntry> input,
        string? model = null,
        string? effort = null)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "turn/start");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("threadId", threadId);
            writer.WritePropertyName("input");
            writer.WriteStartArray();
            foreach (var entry in input)
            {
                writer.WriteStartObject();
                writer.WriteString("type", entry.Type);
                if (string.Equals(entry.Type, "image", StringComparison.Ordinal))
                {
                    writer.WriteString("url", entry.Url);
                }
                else
                {
                    writer.WriteString("text", entry.Text);
                    writer.WritePropertyName("text_elements");
                    writer.WriteStartArray();
                    writer.WriteEndArray();
                }

                writer.WriteEndObject();
            }

            writer.WriteEndArray();
            if (!string.IsNullOrWhiteSpace(model))
            {
                writer.WriteString("model", model);
            }

            if (!string.IsNullOrWhiteSpace(effort))
            {
                writer.WriteString("effort", effort);
            }

            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexTurnInterruptRequest(string id, string threadId, string turnId)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", id);
            writer.WriteString("method", "turn/interrupt");
            writer.WritePropertyName("params");
            writer.WriteStartObject();
            writer.WriteString("threadId", threadId);
            writer.WriteString("turnId", turnId);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexUserInputResponse(
        string jsonRpcId,
        IReadOnlyDictionary<string, CodexQuestionAnswer> answers)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", jsonRpcId);
            writer.WritePropertyName("result");
            writer.WriteStartObject();
            writer.WritePropertyName("answers");
            writer.WriteStartObject();
            foreach (var pair in answers)
            {
                writer.WritePropertyName(pair.Key);
                writer.WriteStartObject();
                writer.WritePropertyName("answers");
                writer.WriteStartArray();
                foreach (var answer in pair.Value.Answers)
                {
                    writer.WriteStringValue(answer);
                }

                writer.WriteEndArray();
                writer.WriteEndObject();
            }

            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexApprovalResponse(string jsonRpcId, string decision)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", jsonRpcId);
            writer.WritePropertyName("result");
            writer.WriteStartObject();
            writer.WriteString("decision", decision);
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static string BuildCodexUnsupportedRequestResponse(string jsonRpcId, string method)
    {
        return BuildJsonString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("id", jsonRpcId);
            writer.WritePropertyName("error");
            writer.WriteStartObject();
            writer.WriteNumber("code", -32601);
            writer.WriteString("message", $"Unsupported Codex server request: {method}");
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    private static async Task<List<CodexTurnInputEntry>> CreateCodexTurnInputAsync(
        LensTurnRequest request,
        string? planMode,
        CancellationToken ct)
    {
        var fileReferences = new List<string>();
        var imageEntries = new List<CodexTurnInputEntry>();

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

            if (string.Equals(attachment.Kind, "image", StringComparison.OrdinalIgnoreCase))
            {
                var fileInfo = new FileInfo(attachment.Path);
                if (fileInfo.Length > MaxInlineImageBytes)
                {
                    throw new InvalidOperationException($"Lens image attachment exceeds {MaxInlineImageBytes.ToString(CultureInfo.InvariantCulture)} bytes: {attachment.Path}");
                }

                var bytes = await File.ReadAllBytesAsync(attachment.Path, ct).ConfigureAwait(false);
                imageEntries.Add(new CodexTurnInputEntry
                {
                    Type = "image",
                    Url = $"data:{ResolveAttachmentMimeType(attachment)};base64,{Convert.ToBase64String(bytes)}"
                });
                continue;
            }

            fileReferences.Add(attachment.Path);
        }

        var input = CreateCodexTurnInput(request.Text, fileReferences, planMode);
        input.AddRange(imageEntries);
        return input;
    }

    private static List<CodexTurnInputEntry> CreateCodexTurnInput(
        string? text,
        IReadOnlyList<string> fileReferences,
        string? planMode)
    {
        var effectiveText = LensQuickSettings.ApplyPlanModePrompt(text, planMode);
        if (fileReferences.Count > 0)
        {
            var fileReferenceBlock = new StringBuilder();
            fileReferenceBlock.AppendLine(fileReferences.Count == 1 ? "Attached file:" : $"Attached files ({fileReferences.Count.ToString(CultureInfo.InvariantCulture)}):");
            foreach (var fileReference in fileReferences)
            {
                fileReferenceBlock.Append("- ");
                fileReferenceBlock.AppendLine(fileReference);
            }

            effectiveText = string.IsNullOrWhiteSpace(effectiveText)
                ? fileReferenceBlock.ToString().Trim()
                : effectiveText + Environment.NewLine + Environment.NewLine + fileReferenceBlock.ToString().Trim();
        }

        var input = new List<CodexTurnInputEntry>();
        if (!string.IsNullOrWhiteSpace(effectiveText))
        {
            input.Add(new CodexTurnInputEntry
            {
                Type = "text",
                Text = effectiveText.Trim()
            });
        }

        return input;
    }

    private LensQuickSettingsSummary CreateDefaultQuickSettings()
    {
        var defaultPermissionMode = LensProviderRuntimeConfiguration.GetCodexYoloDefault()
            ? LensQuickSettings.PermissionModeAuto
            : LensQuickSettings.PermissionModeManual;
        return LensQuickSettings.CreateSummary(
            LensProviderRuntimeConfiguration.GetCodexDefaultModel(),
            null,
            LensQuickSettings.PlanModeOff,
            defaultPermissionMode,
            defaultPermissionMode);
    }

    private LensQuickSettingsSummary ResolveRequestedQuickSettings(LensTurnRequest request)
    {
        var defaultPermissionMode = LensProviderRuntimeConfiguration.GetCodexYoloDefault()
            ? LensQuickSettings.PermissionModeAuto
            : LensQuickSettings.PermissionModeManual;
        return LensQuickSettings.CreateSummary(
            request.Model ?? LensProviderRuntimeConfiguration.GetCodexDefaultModel(),
            request.Effort,
            request.PlanMode,
            request.PermissionMode,
            defaultPermissionMode);
    }

    private async Task ReopenThreadAsync(string permissionMode, CancellationToken ct)
    {
        EnsureAttached();
        if (string.IsNullOrWhiteSpace(_providerThreadId) || string.IsNullOrWhiteSpace(_workingDirectory))
        {
            return;
        }

        var threadResult = await SendCodexRequestAsync(
            "thread/resume",
            id => BuildCodexThreadResumeRequest(id, _providerThreadId!, _workingDirectory!, permissionMode),
            ct).ConfigureAwait(false);
        var resumedThreadId = GetString(threadResult, "thread", "id") ?? GetString(threadResult, "threadId");
        if (!string.IsNullOrWhiteSpace(resumedThreadId))
        {
            _providerThreadId = resumedThreadId;
        }
    }

    private LensHostEventEnvelope CreateQuickSettingsUpdatedEvent(
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

    private static string ResolveCodexApprovalPolicy(string permissionMode)
    {
        return string.Equals(
            LensQuickSettings.NormalizePermissionMode(permissionMode),
            LensQuickSettings.PermissionModeAuto,
            StringComparison.Ordinal)
            ? "never"
            : "on-request";
    }

    private static string ResolveCodexSandbox(string permissionMode)
    {
        return string.Equals(
            LensQuickSettings.NormalizePermissionMode(permissionMode),
            LensQuickSettings.PermissionModeAuto,
            StringComparison.Ordinal)
            ? "danger-full-access"
            : "workspace-write";
    }

    private static string ResolveAttachmentMimeType(LensAttachmentReference attachment)
    {
        if (!string.IsNullOrWhiteSpace(attachment.MimeType))
        {
            return attachment.MimeType;
        }

        return Path.GetExtension(attachment.Path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".bmp" => "image/bmp",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            ".tif" or ".tiff" => "image/tiff",
            ".heic" => "image/heic",
            ".heif" => "image/heif",
            ".avif" => "image/avif",
            _ => "application/octet-stream"
        };
    }

    private static IReadOnlyDictionary<string, CodexQuestionAnswer> ToCodexQuestionAnswers(
        PendingCodexUserInput pending,
        IReadOnlyList<LensPulseAnsweredQuestion> answers)
    {
        var answerMap = answers
            .Where(static answer => !string.IsNullOrWhiteSpace(answer.QuestionId))
            .ToDictionary(
                static answer => answer.QuestionId,
                answer => new CodexQuestionAnswer
                {
                    Answers = answer.Answers.Where(static value => !string.IsNullOrWhiteSpace(value)).ToList()
                },
                StringComparer.Ordinal);

        if (pending.QuestionIds.Count == 0)
        {
            if (answerMap.Count == 0)
            {
                throw new InvalidOperationException("Lens user-input response must include at least one answer.");
            }

            return answerMap;
        }

        var resolvedAnswers = new Dictionary<string, CodexQuestionAnswer>(StringComparer.Ordinal);
        foreach (var questionId in pending.QuestionIds)
        {
            if (!answerMap.TryGetValue(questionId, out var answer) || answer.Answers.Count == 0)
            {
                throw new InvalidOperationException($"Missing answer for Lens question '{questionId}'.");
            }

            resolvedAnswers[questionId] = answer;
        }

        return resolvedAnswers;
    }

    private static string NormalizeApprovalDecision(string? decision)
    {
        var normalized = (decision ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new InvalidOperationException("Lens approval decision is required.");
        }

        if (!SupportedApprovalDecisions.Contains(normalized))
        {
            throw new InvalidOperationException($"Unsupported Lens approval decision '{normalized}'.");
        }

        return normalized;
    }

    private static string BuildJsonString(Action<Utf8JsonWriter> write)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        write(writer);
        writer.Flush();
        return Encoding.UTF8.GetString(buffer.WrittenSpan);
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

        var candidateNames = OperatingSystem.IsWindows()
            ? GetWindowsExecutableNames(commandName)
            : [commandName];

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

        return extensions
            .Select(ext => commandName + ext.ToLowerInvariant())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
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

    private static string BuildCodexItemDetail(JsonElement payload)
    {
        var item = GetObject(payload, "item") ?? payload;
        return GetString(item, "detail")
               ?? GetString(item, "title")
               ?? GetString(item, "text")
               ?? ReadCodexContentText(item)
               ?? GetString(item, "command")
               ?? ReadCodexCommandText(item)
               ?? GetString(item, "summary")
               ?? GetString(item, "kind")
               ?? string.Empty;
    }

    private static string? ReadCodexContentText(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object ||
            !item.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var chunks = new List<string>();
        using var contentItems = content.EnumerateArray();
        while (contentItems.MoveNext())
        {
            var part = contentItems.Current;
            var text = GetString(part, "text");
            if (!string.IsNullOrWhiteSpace(text))
            {
                chunks.Add(text.Trim());
            }
        }

        return chunks.Count == 0 ? null : string.Join("\n\n", chunks);
    }

    private static string? ReadCodexCommandText(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object ||
            !item.TryGetProperty("command", out var command))
        {
            return null;
        }

        if (command.ValueKind == JsonValueKind.String)
        {
            return command.GetString();
        }

        return GetString(command, "command")
               ?? GetString(command, "text")
               ?? GetString(command, "summary");
    }

    private static string BuildCodexPlanMarkdown(JsonElement payload)
    {
        var builder = new StringBuilder();
        var explanation = GetString(payload, "explanation");
        if (!string.IsNullOrWhiteSpace(explanation))
        {
            builder.AppendLine(explanation.Trim());
        }

        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty("plan", out var planElement) &&
            planElement.ValueKind == JsonValueKind.Array)
        {
            using var planItems = planElement.EnumerateArray();
            while (planItems.MoveNext())
            {
                var step = planItems.Current;
                var stepText = GetString(step, "step");
                if (string.IsNullOrWhiteSpace(stepText))
                {
                    continue;
                }

                var status = GetString(step, "status");
                if (builder.Length > 0)
                {
                    builder.AppendLine();
                }

                builder.Append("- ");
                builder.Append(stepText.Trim());
                if (!string.IsNullOrWhiteSpace(status))
                {
                    builder.Append(" [");
                    builder.Append(status.Trim());
                    builder.Append(']');
                }
            }
        }

        return builder.ToString().Trim();
    }

    private static string? ExtractProposedPlanMarkdown(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        const string startTag = "<proposed_plan>";
        const string endTag = "</proposed_plan>";
        var startIndex = value.IndexOf(startTag, StringComparison.OrdinalIgnoreCase);
        if (startIndex < 0)
        {
            return null;
        }

        startIndex += startTag.Length;
        var endIndex = value.IndexOf(endTag, startIndex, StringComparison.OrdinalIgnoreCase);
        if (endIndex < 0)
        {
            return null;
        }

        var extracted = value[startIndex..endIndex].Trim();
        return extracted.Length == 0 ? null : extracted;
    }

    private static string ResolveCodexTaskItemType(string? taskType)
    {
        return string.Equals(taskType, "plan", StringComparison.OrdinalIgnoreCase)
            ? "plan"
            : "reasoning";
    }

    private static (string State, string StateLabel, string Message, string? Detail) ResolveCodexThreadState(string method, JsonElement payload)
    {
        var state = method switch
        {
            "thread/archived" => "archived",
            "thread/unarchived" => "active",
            "thread/closed" => "closed",
            "thread/compacted" => "compacted",
            _ => GetString(payload, "thread", "state") ?? GetString(payload, "state") ?? "active"
        };

        return state switch
        {
            "idle" => ("idle", "Idle", "Codex thread is idle.", null),
            "archived" => ("archived", "Archived", "Codex thread archived.", null),
            "closed" => ("closed", "Closed", "Codex thread closed.", null),
            "compacted" => ("compacted", "Compacted", "Codex compacted the thread context.", null),
            "error" => ("error", "Error", "Codex thread entered an error state.", BuildCompactJsonDetail(payload)),
            _ => ("active", "Active", "Codex thread is active.", null)
        };
    }

    private static string BuildCodexTokenUsageDetail(JsonElement payload)
    {
        var usage = GetObject(payload, "tokenUsage") ?? payload;
        var total = GetLong(usage, "total", "total_tokens")
                    ?? GetLong(usage, "total", "totalTokens")
                    ?? GetLong(usage, "last", "total_tokens")
                    ?? GetLong(usage, "last", "totalTokens");
        var input = GetLong(usage, "last", "input_tokens") ?? GetLong(usage, "last", "inputTokens");
        var output = GetLong(usage, "last", "output_tokens") ?? GetLong(usage, "last", "outputTokens");
        var max = GetLong(usage, "model_context_window") ?? GetLong(usage, "modelContextWindow");

        var parts = new List<string>();
        if (total.HasValue)
        {
            parts.Add($"Used {total.Value.ToString(CultureInfo.InvariantCulture)} tokens");
        }

        if (max.HasValue)
        {
            parts.Add($"window {max.Value.ToString(CultureInfo.InvariantCulture)}");
        }

        if (input.HasValue || output.HasValue)
        {
            parts.Add($"last turn in/out {input.GetValueOrDefault().ToString(CultureInfo.InvariantCulture)}/{output.GetValueOrDefault().ToString(CultureInfo.InvariantCulture)}");
        }

        return parts.Count == 0 ? BuildCompactJsonDetail(payload) ?? "Token usage changed." : string.Join(", ", parts);
    }

    private static string? BuildCompactJsonDetail(JsonElement payload)
    {
        var raw = payload.ValueKind == JsonValueKind.Undefined ? null : payload.GetRawText();
        return string.IsNullOrWhiteSpace(raw) ? null : raw;
    }

    private static string? JoinNonEmpty(params string?[] values)
    {
        var filtered = values
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value!.Trim())
            .ToList();
        return filtered.Count == 0 ? null : string.Join(" | ", filtered);
    }

    private static string MapRealtimeEventType(string method)
    {
        return method switch
        {
            "thread/realtime/started" => "thread.realtime.started",
            "thread/realtime/itemAdded" => "thread.realtime.item-added",
            "thread/realtime/outputAudio/delta" => "thread.realtime.audio.delta",
            "thread/realtime/error" => "thread.realtime.error",
            "thread/realtime/closed" => "thread.realtime.closed",
            _ => "runtime.warning"
        };
    }

    private static string HumanizeRealtimeEvent(string method)
    {
        return method switch
        {
            "thread/realtime/started" => "Codex realtime session started.",
            "thread/realtime/itemAdded" => "Codex realtime item added.",
            "thread/realtime/outputAudio/delta" => "Codex realtime audio updated.",
            "thread/realtime/error" => "Codex realtime session reported an error.",
            "thread/realtime/closed" => "Codex realtime session closed.",
            _ => "Codex realtime update."
        };
    }

    private static string NormalizeCodexItemType(string? value)
    {
        var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        return normalized switch
        {
            "usermessage" => "user_message",
            "user_message" => "user_message",
            "assistantmessage" => "assistant_message",
            "agentmessage" => "assistant_message",
            "agent_message" => "assistant_message",
            "assistant_message" => "assistant_message",
            "commandexecution" => "command_execution",
            "command_execution" => "command_execution",
            "filechange" => "file_change",
            "file_change" => "file_change",
            "websearch" => "web_search",
            "web_search" => "web_search",
            "mcptoolcall" => "mcp_tool_call",
            "mcp_tool_call" => "mcp_tool_call",
            "dynamictoolcall" => "dynamic_tool_call",
            "dynamic_tool_call" => "dynamic_tool_call",
            _ => normalized
        };
    }

    private static string PrettifyToolKind(string itemType)
    {
        return itemType switch
        {
            "command_execution" => "Command",
            "file_change" => "File change",
            "web_search" => "Web search",
            "mcp_tool_call" => "MCP tool",
            "dynamic_tool_call" => "Tool",
            _ => "Tool"
        };
    }

    private static string ReadCodexQuestionSummary(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("questions", out var questions) ||
            questions.ValueKind != JsonValueKind.Array)
        {
            return "Codex is waiting for user input.";
        }

        using (var questionItems = questions.EnumerateArray())
        {
            while (questionItems.MoveNext())
            {
                var question = questionItems.Current;
                var prompt = GetString(question, "question");
                if (!string.IsNullOrWhiteSpace(prompt))
                {
                    return prompt;
                }
            }
        }

        return "Codex is waiting for user input.";
    }

    private static List<string> ReadCodexQuestionIds(JsonElement payload)
    {
        var ids = new List<string>();
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("questions", out var questions) ||
            questions.ValueKind != JsonValueKind.Array)
        {
            return ids;
        }

        using var questionIdItems = questions.EnumerateArray();
        while (questionIdItems.MoveNext())
        {
            var question = questionIdItems.Current;
            var id = GetString(question, "id");
            if (!string.IsNullOrWhiteSpace(id))
            {
                ids.Add(id);
            }
        }

        return ids;
    }

    private static List<LensPulseQuestion> ReadCodexQuestions(JsonElement payload)
    {
        var questions = new List<LensPulseQuestion>();
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("questions", out var questionArray) ||
            questionArray.ValueKind != JsonValueKind.Array)
        {
            return questions;
        }

        using var questionItems = questionArray.EnumerateArray();
        while (questionItems.MoveNext())
        {
            var question = questionItems.Current;
            var item = new LensPulseQuestion
            {
                Id = GetString(question, "id") ?? string.Empty,
                Header = GetString(question, "header") ?? string.Empty,
                Question = GetString(question, "question") ?? string.Empty,
                MultiSelect = GetBoolean(question, "multiSelect")
            };

            if (question.TryGetProperty("options", out var options) && options.ValueKind == JsonValueKind.Array)
            {
                using var optionItems = options.EnumerateArray();
                while (optionItems.MoveNext())
                {
                    var option = optionItems.Current;
                    item.Options.Add(new LensPulseQuestionOption
                    {
                        Label = GetString(option, "label") ?? string.Empty,
                        Description = GetString(option, "description") ?? string.Empty
                    });
                }
            }

            questions.Add(item);
        }

        return questions;
    }

    private static string HumanizeTurnState(string turnState)
    {
        return turnState switch
        {
            "failed" => "Failed",
            "cancelled" => "Cancelled",
            "interrupted" => "Interrupted",
            _ => "Completed"
        };
    }

    private static string HumanizeRequestType(string requestType)
    {
        return requestType switch
        {
            "command_execution_approval" => "Command approval",
            "file_read_approval" => "File read approval",
            "file_change_approval" => "File change approval",
            "tool_user_input" => "User input",
            _ => requestType
        };
    }

    private static string? GetString(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.String } value
            ? value.GetString()
            : null;
    }

    private static bool GetBoolean(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.True } || current is { ValueKind: JsonValueKind.False } value && value.GetBoolean();
    }

    private static long? GetLong(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        if (current is not JsonElement value)
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.Number when value.TryGetInt64(out var number) => number,
            JsonValueKind.String when long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) => parsed,
            _ => null
        };
    }

    private static JsonElement? GetObject(JsonElement element, params string[] path)
    {
        var current = Traverse(element, path);
        return current is { ValueKind: JsonValueKind.Object } value ? value : null;
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

    private sealed class JsonRpcReply
    {
        public bool IsError { get; set; }
        public string? ErrorMessage { get; set; }
        public JsonElement Payload { get; set; }
    }

    private sealed class CodexTurnInputEntry
    {
        public string Type { get; set; } = string.Empty;
        public string? Text { get; set; }
        public string? Url { get; set; }
    }

    private sealed class CodexQuestionAnswer
    {
        public List<string> Answers { get; set; } = [];
    }

    private sealed class PendingCodexUserInput
    {
        public string RequestId { get; set; } = string.Empty;
        public string JsonRpcId { get; set; } = string.Empty;
        public string? TurnId { get; set; }
        public string? ItemId { get; set; }
        public List<string> QuestionIds { get; set; } = [];
        public string Summary { get; set; } = string.Empty;
        public DateTimeOffset CreatedAt { get; set; }
    }

    private sealed class PendingCodexApproval
    {
        public string RequestId { get; set; } = string.Empty;
        public string JsonRpcId { get; set; } = string.Empty;
        public string RequestType { get; set; } = string.Empty;
        public string RequestTypeLabel { get; set; } = string.Empty;
        public string? TurnId { get; set; }
        public string? ItemId { get; set; }
        public string? Detail { get; set; }
    }
}
