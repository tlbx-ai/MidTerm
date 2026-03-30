using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Threading.Channels;
using Ai.Tlbx.MidTerm.Common.Ipc;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.AgentHost;

internal sealed class LensAgentHostServer : IAsyncDisposable
{
    private readonly string? _syntheticProvider;
    private readonly string? _ownerInstanceId;
    private readonly string? _ownerToken;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Lock _eventLock = new();
    private readonly List<LensPulseEvent> _events = [];
    private readonly Lock _clientLock = new();
    private ConnectionState? _currentClient;
    private ILensAgentRuntime? _runtime;
    private long _nextSequence;
    private readonly List<Task> _connectionTasks = [];

    public LensAgentHostServer(string? syntheticProvider, string? ownerInstanceId = null, string? ownerToken = null)
    {
        _syntheticProvider = string.IsNullOrWhiteSpace(syntheticProvider)
            ? null
            : syntheticProvider.Trim().ToLowerInvariant();
        _ownerInstanceId = string.IsNullOrWhiteSpace(ownerInstanceId) ? null : ownerInstanceId;
        _ownerToken = string.IsNullOrWhiteSpace(ownerToken) ? null : ownerToken;
    }

    public async Task RunStdioAsync()
    {
        using var reader = new StreamReader(Console.OpenStandardInput());
        using var writer = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
        using var connection = new ConnectionState(reader, writer, null, _shutdown.Token);

        PromoteCurrentClient(connection);
        await EnqueueHelloAsync(connection).ConfigureAwait(false);
        await ProcessIncomingAsync(connection, requireOwnership: false, promoteOnAttach: false).ConfigureAwait(false);
    }

    public async Task RunIpcAsync(string endpoint)
    {
        using var server = IpcServerFactory.Create(endpoint);

        while (!_shutdown.IsCancellationRequested)
        {
            IIpcClientConnection? client = null;
            try
            {
                client = await server.AcceptAsync(_shutdown.Token).ConfigureAwait(false);
                var stream = client.Stream;
                var reader = new StreamReader(stream, System.Text.Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: false);
                var writer = new StreamWriter(stream, System.Text.Encoding.UTF8, bufferSize: 1024, leaveOpen: false) { AutoFlush = true };
                var connection = new ConnectionState(reader, writer, client, _shutdown.Token);
                var task = Task.Run(() => ProcessConnectionAsync(connection), CancellationToken.None);
                lock (_connectionTasks)
                {
                    _connectionTasks.Add(task);
                }

                _ = task.ContinueWith(
                    completed =>
                    {
                        lock (_connectionTasks)
                        {
                            _connectionTasks.Remove(completed);
                        }
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.None,
                    TaskScheduler.Default);
            }
            catch (OperationCanceledException)
            {
                client?.Dispose();
                break;
            }
            catch
            {
                client?.Dispose();
                await Task.Delay(100, _shutdown.Token).ConfigureAwait(false);
            }
        }

        Task[] remaining;
        lock (_connectionTasks)
        {
            remaining = _connectionTasks.ToArray();
        }

        if (remaining.Length > 0)
        {
            await Task.WhenAll(remaining).ConfigureAwait(false);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown.Cancel();

        lock (_clientLock)
        {
            _currentClient?.Dispose();
            _currentClient = null;
        }

        if (_runtime is not null)
        {
            await _runtime.DisposeAsync().ConfigureAwait(false);
        }

        Task[] remaining;
        lock (_connectionTasks)
        {
            remaining = _connectionTasks.ToArray();
        }

        if (remaining.Length > 0)
        {
            await Task.WhenAll(remaining).ConfigureAwait(false);
        }

        _shutdown.Dispose();
    }

    private async Task ProcessConnectionAsync(ConnectionState connection)
    {
        using (connection)
        {
            await EnqueueHelloAsync(connection).ConfigureAwait(false);
            await ProcessIncomingAsync(connection, requireOwnership: true, promoteOnAttach: true).ConfigureAwait(false);
        }

        lock (_clientLock)
        {
            if (ReferenceEquals(_currentClient, connection))
            {
                _currentClient = null;
            }
        }
    }

    private async Task ProcessIncomingAsync(ConnectionState connection, bool requireOwnership, bool promoteOnAttach)
    {
        while (!connection.Token.IsCancellationRequested &&
               await connection.Reader.ReadLineAsync(connection.Token).ConfigureAwait(false) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            LensHostCommandEnvelope? command;
            try
            {
                command = JsonSerializer.Deserialize(line, LensHostJsonContext.Default.LensHostCommandEnvelope);
            }
            catch (JsonException ex)
            {
                await EnqueueAsync(
                    connection,
                    new LensHostCommandResultEnvelope
                    {
                        CommandId = "invalid-json",
                        SessionId = string.Empty,
                        Status = "rejected",
                        Message = ex.Message
                    },
                    LensHostJsonContext.Default.LensHostCommandResultEnvelope).ConfigureAwait(false);
                continue;
            }

            if (command is null)
            {
                continue;
            }

            if (!connection.OwnerValidated)
            {
                if (!string.Equals(command.Type, "runtime.attach", StringComparison.Ordinal))
                {
                    await EnqueueRejectedAsync(connection, command, "runtime.attach must be the first command sent to mtagenthost.").ConfigureAwait(false);
                    break;
                }

                if (requireOwnership && !ValidateOwnership(command.AttachRuntime))
                {
                    await EnqueueRejectedAsync(connection, command, "mtagenthost ownership mismatch").ConfigureAwait(false);
                    break;
                }

                connection.OwnerValidated = true;
                if (promoteOnAttach)
                {
                    PromoteCurrentClient(connection);
                }
            }

            HostCommandOutcome outcome;
            try
            {
                outcome = await ExecuteCommandAsync(command).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                outcome = new HostCommandOutcome
                {
                    Result = new LensHostCommandResultEnvelope
                    {
                        CommandId = command.CommandId,
                        SessionId = command.SessionId,
                        Status = "rejected",
                        Message = ex.Message
                    }
                };
            }

            foreach (var envelope in outcome.Events)
            {
                StoreRuntimeEvent(envelope);
            }
            await EnqueueAsync(connection, outcome.Result, LensHostJsonContext.Default.LensHostCommandResultEnvelope).ConfigureAwait(false);
            foreach (var envelope in outcome.Events)
            {
                ForwardRuntimeEvent(envelope);
            }
        }
    }

    private async Task<HostCommandOutcome> ExecuteCommandAsync(LensHostCommandEnvelope command)
    {
        ValidateCommand(command);

        if (string.Equals(command.Type, "events.get", StringComparison.Ordinal))
        {
            return new HostCommandOutcome
            {
                Result = new LensHostCommandResultEnvelope
                {
                    CommandId = command.CommandId,
                    SessionId = command.SessionId,
                    Status = "accepted",
                    Events = GetEvents(command.SessionId, command.EventsRequest?.AfterSequence ?? 0)
                }
            };
        }

        var runtime = await GetRuntimeAsync(command).ConfigureAwait(false);
        var outcome = await runtime.ExecuteAsync(command, _shutdown.Token).ConfigureAwait(false);
        return MaybeAppendSubmittedUserMessage(command, outcome, runtime.Provider);
    }

    private static HostCommandOutcome MaybeAppendSubmittedUserMessage(
        LensHostCommandEnvelope command,
        HostCommandOutcome outcome,
        string provider)
    {
        if (!string.Equals(command.Type, "turn.start", StringComparison.Ordinal))
        {
            return outcome;
        }

        var request = command.StartTurn;
        var turnStarted = outcome.Result.TurnStarted;
        if (request is null ||
            turnStarted is null ||
            !string.Equals(outcome.Result.Status, "accepted", StringComparison.OrdinalIgnoreCase) ||
            (string.IsNullOrWhiteSpace(request.Text) && request.Attachments.Count == 0))
        {
            return outcome;
        }

        var events = outcome.Events.ToList();
        events.Insert(0, new LensHostEventEnvelope
        {
            SessionId = command.SessionId,
            Event = new LensPulseEvent
            {
                EventId = $"evt-user-{Guid.NewGuid():N}",
                SessionId = command.SessionId,
                Provider = turnStarted.Provider,
                ThreadId = turnStarted.ThreadId,
                TurnId = turnStarted.TurnId,
                ItemId = $"user:{turnStarted.TurnId ?? Guid.NewGuid().ToString("N")}",
                CreatedAt = DateTimeOffset.UtcNow,
                Type = "item.completed",
                Item = new LensPulseItemPayload
                {
                    ItemType = "user_message",
                    Status = "completed",
                    Title = "User message",
                    Detail = request.Text,
                    Attachments = CloneAttachments(request.Attachments)
                }
            }
        });

        return new HostCommandOutcome
        {
            Result = outcome.Result,
            Events = events
        };
    }

    private LensPulseEventListResponse GetEvents(string sessionId, long afterSequence)
    {
        lock (_eventLock)
        {
            return new LensPulseEventListResponse
            {
                SessionId = sessionId,
                LatestSequence = _nextSequence,
                Events = _events
                    .Where(lensEvent => lensEvent.Sequence > afterSequence &&
                                        string.Equals(lensEvent.SessionId, sessionId, StringComparison.Ordinal))
                    .Select(CloneEvent)
                    .ToList()
            };
        }
    }

    private void PromoteCurrentClient(ConnectionState nextClient)
    {
        lock (_clientLock)
        {
            if (ReferenceEquals(_currentClient, nextClient))
            {
                return;
            }

            var previous = _currentClient;
            _currentClient = nextClient;
            previous?.Dispose();
        }
    }

    private bool ValidateOwnership(LensAttachRuntimeRequest? attach)
    {
        if (attach is null)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(_ownerInstanceId) || string.IsNullOrWhiteSpace(_ownerToken))
        {
            return true;
        }

        return string.Equals(attach.InstanceId, _ownerInstanceId, StringComparison.Ordinal) &&
               string.Equals(attach.OwnerToken, _ownerToken, StringComparison.Ordinal);
    }

    private async Task EnqueueHelloAsync(ConnectionState connection)
    {
        await EnqueueAsync(
            connection,
            new LensHostHello
            {
                HostKind = "mtagenthost",
                HostVersion = "dev",
                Providers = _syntheticProvider is null ? ["codex", "claude"] : [_syntheticProvider],
                Capabilities =
                [
                    "attach",
                    "turn.start",
                    "turn.interrupt",
                    "request.resolve",
                    "user-input.resolve",
                    "events.get"
                ]
            },
            LensHostJsonContext.Default.LensHostHello).ConfigureAwait(false);
    }

    private async Task EnqueueRejectedAsync(ConnectionState connection, LensHostCommandEnvelope command, string message)
    {
        await EnqueueAsync(
            connection,
            new LensHostCommandResultEnvelope
            {
                CommandId = command.CommandId,
                SessionId = command.SessionId,
                Status = "rejected",
                Message = message
            },
            LensHostJsonContext.Default.LensHostCommandResultEnvelope).ConfigureAwait(false);
    }

    private async Task<ILensAgentRuntime> GetRuntimeAsync(LensHostCommandEnvelope command)
    {
        if (_runtime is not null)
        {
            return _runtime;
        }

        if (!string.Equals(command.Type, "runtime.attach", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("runtime.attach must be the first command sent to mtagenthost.");
        }

        var provider = _syntheticProvider ?? command.AttachRuntime?.Provider?.Trim().ToLowerInvariant();
        _runtime = provider switch
        {
            "codex" when _syntheticProvider is null => new CodexLensAgentRuntime(EmitRuntimeEvent),
            "claude" when _syntheticProvider is null => new ClaudeLensAgentRuntime(EmitRuntimeEvent),
            "codex" => new SyntheticLensAgentRuntime(provider, EmitRuntimeEvent),
            "claude" when _syntheticProvider is not null => new SyntheticLensAgentRuntime(provider, EmitRuntimeEvent),
            _ => throw new InvalidOperationException($"mtagenthost does not support provider '{provider ?? "(null)"}'.")
        };

        return _runtime;
    }

    private static void ValidateCommand(LensHostCommandEnvelope command)
    {
        if (!string.Equals(command.ProtocolVersion, LensHostProtocol.CurrentVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Unsupported protocol version '{command.ProtocolVersion}'.");
        }

        if (string.IsNullOrWhiteSpace(command.CommandId))
        {
            throw new InvalidOperationException("Command id is required.");
        }

        if (string.IsNullOrWhiteSpace(command.SessionId))
        {
            throw new InvalidOperationException("Session id is required.");
        }
    }

    private void EmitRuntimeEvent(LensHostEventEnvelope envelope)
    {
        StoreRuntimeEvent(envelope);
        ForwardRuntimeEvent(envelope);
    }

    private void StoreRuntimeEvent(LensHostEventEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(envelope.Event);

        var lensEvent = LensEventCompaction.CloneForRetention(envelope.Event);
        lock (_eventLock)
        {
            lensEvent.Sequence = ++_nextSequence;
            _events.Add(lensEvent);
        }

        envelope.Event = CloneEvent(lensEvent);
    }

    private void ForwardRuntimeEvent(LensHostEventEnvelope envelope)
    {
        ConnectionState? current;
        lock (_clientLock)
        {
            current = _currentClient;
        }

        if (current is null || current.Token.IsCancellationRequested)
        {
            return;
        }

        current.Outbound.Writer.TryWrite(
            JsonSerializer.Serialize(
                new LensHostEventEnvelope
                {
                    ProtocolVersion = envelope.ProtocolVersion,
                    SessionId = envelope.SessionId,
                    Event = CloneEvent(envelope.Event)
                },
                LensHostJsonContext.Default.LensHostEventEnvelope));
    }

    private static LensPulseEvent CloneEvent(LensPulseEvent lensEvent)
    {
        return new LensPulseEvent
        {
            Sequence = lensEvent.Sequence,
            EventId = lensEvent.EventId,
            SessionId = lensEvent.SessionId,
            Provider = lensEvent.Provider,
            ThreadId = lensEvent.ThreadId,
            TurnId = lensEvent.TurnId,
            ItemId = lensEvent.ItemId,
            RequestId = lensEvent.RequestId,
            CreatedAt = lensEvent.CreatedAt,
            Type = lensEvent.Type,
            Raw = lensEvent.Raw is null ? null : new LensPulseEventRaw
            {
                Source = lensEvent.Raw.Source,
                Method = lensEvent.Raw.Method,
                PayloadJson = lensEvent.Raw.PayloadJson
            },
            SessionState = lensEvent.SessionState is null ? null : new LensPulseSessionStatePayload
            {
                State = lensEvent.SessionState.State,
                StateLabel = lensEvent.SessionState.StateLabel,
                Reason = lensEvent.SessionState.Reason
            },
            ThreadState = lensEvent.ThreadState is null ? null : new LensPulseThreadStatePayload
            {
                State = lensEvent.ThreadState.State,
                StateLabel = lensEvent.ThreadState.StateLabel,
                ProviderThreadId = lensEvent.ThreadState.ProviderThreadId
            },
            TurnStarted = lensEvent.TurnStarted is null ? null : new LensPulseTurnStartedPayload
            {
                Model = lensEvent.TurnStarted.Model,
                Effort = lensEvent.TurnStarted.Effort
            },
            TurnCompleted = lensEvent.TurnCompleted is null ? null : new LensPulseTurnCompletedPayload
            {
                State = lensEvent.TurnCompleted.State,
                StateLabel = lensEvent.TurnCompleted.StateLabel,
                StopReason = lensEvent.TurnCompleted.StopReason,
                ErrorMessage = lensEvent.TurnCompleted.ErrorMessage
            },
            ContentDelta = lensEvent.ContentDelta is null ? null : new LensPulseContentDeltaPayload
            {
                StreamKind = lensEvent.ContentDelta.StreamKind,
                Delta = lensEvent.ContentDelta.Delta
            },
            PlanDelta = lensEvent.PlanDelta is null ? null : new LensPulsePlanDeltaPayload
            {
                Delta = lensEvent.PlanDelta.Delta
            },
            PlanCompleted = lensEvent.PlanCompleted is null ? null : new LensPulsePlanCompletedPayload
            {
                PlanMarkdown = lensEvent.PlanCompleted.PlanMarkdown
            },
            DiffUpdated = lensEvent.DiffUpdated is null ? null : new LensPulseDiffUpdatedPayload
            {
                UnifiedDiff = lensEvent.DiffUpdated.UnifiedDiff
            },
            Item = lensEvent.Item is null ? null : new LensPulseItemPayload
            {
                ItemType = lensEvent.Item.ItemType,
                Status = lensEvent.Item.Status,
                Title = lensEvent.Item.Title,
                Detail = lensEvent.Item.Detail,
                Attachments = CloneAttachments(lensEvent.Item.Attachments)
            },
            QuickSettingsUpdated = lensEvent.QuickSettingsUpdated is null ? null : new LensPulseQuickSettingsPayload
            {
                Model = lensEvent.QuickSettingsUpdated.Model,
                Effort = lensEvent.QuickSettingsUpdated.Effort,
                PlanMode = LensQuickSettings.NormalizePlanMode(lensEvent.QuickSettingsUpdated.PlanMode),
                PermissionMode = LensQuickSettings.NormalizePermissionMode(lensEvent.QuickSettingsUpdated.PermissionMode)
            },
            RequestOpened = lensEvent.RequestOpened is null ? null : new LensPulseRequestOpenedPayload
            {
                RequestType = lensEvent.RequestOpened.RequestType,
                RequestTypeLabel = lensEvent.RequestOpened.RequestTypeLabel,
                Detail = lensEvent.RequestOpened.Detail
            },
            RequestResolved = lensEvent.RequestResolved is null ? null : new LensPulseRequestResolvedPayload
            {
                RequestType = lensEvent.RequestResolved.RequestType,
                Decision = lensEvent.RequestResolved.Decision
            },
            UserInputRequested = lensEvent.UserInputRequested is null ? null : new LensPulseUserInputRequestedPayload
            {
                Questions = lensEvent.UserInputRequested.Questions.Select(CloneQuestion).ToList()
            },
            UserInputResolved = lensEvent.UserInputResolved is null ? null : new LensPulseUserInputResolvedPayload
            {
                Answers = lensEvent.UserInputResolved.Answers.Select(CloneAnsweredQuestion).ToList()
            },
            RuntimeMessage = lensEvent.RuntimeMessage is null ? null : new LensPulseRuntimeMessagePayload
            {
                Message = lensEvent.RuntimeMessage.Message,
                Detail = lensEvent.RuntimeMessage.Detail
            }
        };
    }

    private static List<LensAttachmentReference> CloneAttachments(IReadOnlyList<LensAttachmentReference>? attachments)
    {
        if (attachments is null || attachments.Count == 0)
        {
            return [];
        }

        return attachments.Select(static attachment => new LensAttachmentReference
        {
            Kind = attachment.Kind,
            Path = attachment.Path,
            MimeType = attachment.MimeType,
            DisplayName = string.IsNullOrWhiteSpace(attachment.DisplayName)
                ? Path.GetFileName(attachment.Path)
                : attachment.DisplayName
        }).ToList();
    }

    private static LensPulseQuestion CloneQuestion(LensPulseQuestion source)
    {
        return new LensPulseQuestion
        {
            Id = source.Id,
            Header = source.Header,
            Question = source.Question,
            MultiSelect = source.MultiSelect,
            Options = source.Options.Select(static option => new LensPulseQuestionOption
            {
                Label = option.Label,
                Description = option.Description
            }).ToList()
        };
    }

    private static LensPulseAnsweredQuestion CloneAnsweredQuestion(LensPulseAnsweredQuestion source)
    {
        return new LensPulseAnsweredQuestion
        {
            QuestionId = source.QuestionId,
            Answers = [.. source.Answers]
        };
    }

    private static async Task EnqueueAsync<T>(
        ConnectionState connection,
        T payload,
        JsonTypeInfo<T> typeInfo)
    {
        await connection.Outbound.Writer.WriteAsync(JsonSerializer.Serialize(payload, typeInfo), connection.Token).ConfigureAwait(false);
    }

    private sealed class ConnectionState : IDisposable
    {
        private readonly CancellationTokenSource _cts;
        private bool _disposed;

        public ConnectionState(
            StreamReader reader,
            StreamWriter writer,
            IIpcClientConnection? connection,
            CancellationToken shutdownToken)
        {
            Reader = reader;
            Writer = writer;
            Connection = connection;
            _cts = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            Outbound = Channel.CreateUnbounded<string>(new UnboundedChannelOptions
            {
                SingleReader = true,
                SingleWriter = false
            });
            WriterTask = Task.Run(() => WriteLoopAsync(this), CancellationToken.None);
        }

        public StreamReader Reader { get; }
        public StreamWriter Writer { get; }
        public IIpcClientConnection? Connection { get; }
        public Channel<string> Outbound { get; }
        public Task WriterTask { get; }
        public CancellationToken Token => _cts.Token;
        public bool OwnerValidated { get; set; }

        private static async Task WriteLoopAsync(ConnectionState state)
        {
            try
            {
                while (await state.Outbound.Reader.WaitToReadAsync(state.Token).ConfigureAwait(false))
                {
                    while (state.Outbound.Reader.TryRead(out var line))
                    {
                        await state.Writer.WriteLineAsync(line).ConfigureAwait(false);
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

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _cts.Cancel();
            Outbound.Writer.TryComplete();
            try { Writer.Dispose(); } catch { }
            try { Reader.Dispose(); } catch { }
            try { Connection?.Dispose(); } catch { }
            try { WriterTask.Wait(250); } catch { }
            _cts.Dispose();
        }
    }
}
