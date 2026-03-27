using System.Collections.Concurrent;
using System.Threading.Channels;
using System.Text;
using Ai.Tlbx.MidTerm.Common.Protocol;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public sealed class SessionLensPulseService
{
    private const int MaxEventsPerSession = 600;
    private readonly ConcurrentDictionary<string, SessionLensPulseLog> _logs = new(StringComparer.Ordinal);

    public void Append(LensPulseEvent lensEvent)
    {
        ArgumentNullException.ThrowIfNull(lensEvent);

        var log = _logs.GetOrAdd(lensEvent.SessionId, static sessionId => new SessionLensPulseLog(sessionId));
        lock (log.SyncRoot)
        {
            lensEvent.Sequence = ++log.NextSequence;
            log.Events.Add(lensEvent);
            if (log.Events.Count > MaxEventsPerSession)
            {
                log.Events.RemoveRange(0, log.Events.Count - MaxEventsPerSession);
            }

            var staleSubscribers = new List<LensPulseSubscriber>();
            foreach (var subscriber in log.Subscribers)
            {
                if (!subscriber.Writer.TryWrite(CloneEvent(lensEvent)))
                {
                    staleSubscribers.Add(subscriber);
                }
            }

            if (staleSubscribers.Count > 0)
            {
                foreach (var staleSubscriber in staleSubscribers)
                {
                    log.Subscribers.Remove(staleSubscriber);
                }
            }
        }
    }

    public LensPulseSubscription Subscribe(string sessionId, long afterSequence, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);

        var log = _logs.GetOrAdd(sessionId, static id => new SessionLensPulseLog(id));
        var channel = Channel.CreateUnbounded<LensPulseEvent>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });
        var subscriber = new LensPulseSubscriber(channel.Writer);
        List<LensPulseEvent> backlog;

        lock (log.SyncRoot)
        {
            backlog = log.Events
                .Where(lensEvent => lensEvent.Sequence > afterSequence)
                .Select(CloneEvent)
                .ToList();
            log.Subscribers.Add(subscriber);
        }

        foreach (var lensEvent in backlog)
        {
            channel.Writer.TryWrite(lensEvent);
        }

        CancellationTokenRegistration registration = default;

        var subscription = new LensPulseSubscription(
            channel.Reader,
            () =>
            {
                registration.Dispose();
                lock (log.SyncRoot)
                {
                    log.Subscribers.Remove(subscriber);
                }

                channel.Writer.TryComplete();
            });

        if (cancellationToken.CanBeCanceled)
        {
            registration = cancellationToken.Register(static state =>
            {
                if (state is LensPulseSubscription subscription)
                {
                    subscription.Dispose();
                }
            }, subscription);
        }

        return subscription;
    }

    public LensPulseEventListResponse GetEvents(string sessionId, long afterSequence = 0)
    {
        if (!_logs.TryGetValue(sessionId, out var log))
        {
            return new LensPulseEventListResponse
            {
                SessionId = sessionId
            };
        }

        lock (log.SyncRoot)
        {
            return new LensPulseEventListResponse
            {
                SessionId = sessionId,
                LatestSequence = log.NextSequence,
                Events = log.Events
                    .Where(e => e.Sequence > afterSequence)
                    .Select(CloneEvent)
                    .ToList()
            };
        }
    }

    public bool HasHistory(string sessionId)
    {
        if (!_logs.TryGetValue(sessionId, out var log))
        {
            return false;
        }

        lock (log.SyncRoot)
        {
            return log.Events.Count > 0;
        }
    }

    public LensPulseSnapshotResponse? GetSnapshot(string sessionId)
    {
        if (!_logs.TryGetValue(sessionId, out var log))
        {
            return null;
        }

        lock (log.SyncRoot)
        {
            if (log.Events.Count == 0)
            {
                return null;
            }

            var snapshot = new LensPulseSnapshotResponse
            {
                SessionId = sessionId,
                GeneratedAt = DateTimeOffset.UtcNow,
                LatestSequence = log.NextSequence
            };

            var items = new Dictionary<string, LensPulseItemSummary>(StringComparer.Ordinal);
            var requests = new Dictionary<string, LensPulseRequestSummary>(StringComparer.Ordinal);
            var notices = new List<LensPulseRuntimeNotice>();
            var assistant = new StringBuilder();
            var reasoning = new StringBuilder();
            var reasoningSummary = new StringBuilder();
            var plan = new StringBuilder();
            var commandOutput = new StringBuilder();
            var fileChangeOutput = new StringBuilder();

            foreach (var lensEvent in log.Events.OrderBy(e => e.Sequence))
            {
                snapshot.Provider = lensEvent.Provider;
                snapshot.Session.LastEventAt = lensEvent.CreatedAt;
                if (!string.IsNullOrWhiteSpace(lensEvent.ThreadId))
                {
                    snapshot.Thread.ThreadId = lensEvent.ThreadId;
                }

                switch (lensEvent.Type)
                {
                    case "session.started":
                    case "session.ready":
                    case "session.state.changed":
                    case "session.exited":
                        ApplySessionState(snapshot, lensEvent);
                        break;

                    case "thread.started":
                    case "thread.state.changed":
                        ApplyThreadState(snapshot, lensEvent);
                        break;

                    case "turn.started":
                        assistant.Clear();
                        reasoning.Clear();
                        reasoningSummary.Clear();
                        plan.Clear();
                        commandOutput.Clear();
                        fileChangeOutput.Clear();
                        snapshot.Streams.UnifiedDiff = string.Empty;
                        snapshot.CurrentTurn = new LensPulseTurnSummary
                        {
                            TurnId = lensEvent.TurnId,
                            State = "running",
                            StateLabel = "Running",
                            Model = lensEvent.TurnStarted?.Model,
                            Effort = lensEvent.TurnStarted?.Effort,
                            StartedAt = lensEvent.CreatedAt
                        };
                        break;

                    case "turn.completed":
                    case "turn.aborted":
                        snapshot.CurrentTurn.State = lensEvent.TurnCompleted?.State ?? "completed";
                        snapshot.CurrentTurn.StateLabel = lensEvent.TurnCompleted?.StateLabel ?? "Completed";
                        snapshot.CurrentTurn.CompletedAt = lensEvent.CreatedAt;
                        if (!string.IsNullOrWhiteSpace(lensEvent.TurnCompleted?.ErrorMessage))
                        {
                            snapshot.Session.LastError = lensEvent.TurnCompleted.ErrorMessage;
                        }
                        break;

                    case "content.delta":
                        ApplyContentDelta(lensEvent, assistant, reasoning, reasoningSummary, plan, commandOutput, fileChangeOutput);
                        break;

                    case "plan.delta":
                        if (lensEvent.PlanDelta is not null)
                        {
                            plan.Append(lensEvent.PlanDelta.Delta);
                        }
                        break;

                    case "plan.completed":
                        if (!string.IsNullOrWhiteSpace(lensEvent.PlanCompleted?.PlanMarkdown))
                        {
                            plan.Clear();
                            plan.Append(lensEvent.PlanCompleted.PlanMarkdown);
                        }
                        break;

                    case "diff.updated":
                        if (lensEvent.DiffUpdated is not null)
                        {
                            snapshot.Streams.UnifiedDiff = lensEvent.DiffUpdated.UnifiedDiff;
                        }
                        break;

                    case "item.started":
                    case "item.updated":
                    case "item.completed":
                        if (lensEvent.Item is not null)
                        {
                            var itemId = lensEvent.ItemId ?? lensEvent.EventId;
                            var normalizedItemType = NormalizeItemType(lensEvent.Item.ItemType);
                            if (normalizedItemType == "user_message" &&
                                !itemId.StartsWith("local-user:", StringComparison.Ordinal) &&
                                TryFindLocalUserMessageItem(items, lensEvent.TurnId, out var existingUserItemId))
                            {
                                var existing = items[existingUserItemId];
                                items[existingUserItemId] = new LensPulseItemSummary
                                {
                                    ItemId = existingUserItemId,
                                    TurnId = lensEvent.TurnId ?? existing.TurnId,
                                    ItemType = "user_message",
                                    Status = ChoosePreferredUserMessageStatus(existing.Status, lensEvent.Item.Status),
                                    Title = string.IsNullOrWhiteSpace(existing.Title) ? lensEvent.Item.Title : existing.Title,
                                    Detail = string.IsNullOrWhiteSpace(existing.Detail) ? lensEvent.Item.Detail : existing.Detail,
                                    Attachments = existing.Attachments.Count > 0
                                        ? CloneAttachments(existing.Attachments)
                                        : CloneAttachments(lensEvent.Item.Attachments),
                                    UpdatedAt = lensEvent.CreatedAt
                                };
                                break;
                            }

                            items[itemId] = new LensPulseItemSummary
                            {
                                ItemId = itemId,
                                TurnId = lensEvent.TurnId,
                                ItemType = normalizedItemType,
                                Status = lensEvent.Item.Status,
                                Title = lensEvent.Item.Title,
                                Detail = lensEvent.Item.Detail,
                                Attachments = CloneAttachments(lensEvent.Item.Attachments),
                                UpdatedAt = lensEvent.CreatedAt
                            };
                        }
                        break;

                    case "request.opened":
                        if (lensEvent.RequestOpened is not null && lensEvent.RequestId is not null)
                        {
                            requests[lensEvent.RequestId] = new LensPulseRequestSummary
                            {
                                RequestId = lensEvent.RequestId,
                                TurnId = lensEvent.TurnId,
                                Kind = lensEvent.RequestOpened.RequestType,
                                KindLabel = lensEvent.RequestOpened.RequestTypeLabel,
                                State = "open",
                                Detail = lensEvent.RequestOpened.Detail,
                                UpdatedAt = lensEvent.CreatedAt
                            };
                        }
                        break;

                    case "request.resolved":
                        if (lensEvent.RequestResolved is not null && lensEvent.RequestId is not null)
                        {
                            var request = GetOrCreateRequestSummary(requests, lensEvent.RequestId, lensEvent.TurnId);
                            request.Kind = lensEvent.RequestResolved.RequestType;
                            request.KindLabel = HumanizeRequestType(lensEvent.RequestResolved.RequestType);
                            request.State = "resolved";
                            request.Decision = lensEvent.RequestResolved.Decision;
                            request.UpdatedAt = lensEvent.CreatedAt;
                        }
                        break;

                    case "user-input.requested":
                        if (lensEvent.UserInputRequested is not null && lensEvent.RequestId is not null)
                        {
                            var request = GetOrCreateRequestSummary(requests, lensEvent.RequestId, lensEvent.TurnId);
                            request.Kind = "tool_user_input";
                            request.KindLabel = "User input";
                            request.State = "open";
                            request.Questions = lensEvent.UserInputRequested.Questions.Select(CloneQuestion).ToList();
                            request.UpdatedAt = lensEvent.CreatedAt;
                        }
                        break;

                    case "user-input.resolved":
                        if (lensEvent.UserInputResolved is not null && lensEvent.RequestId is not null)
                        {
                            var request = GetOrCreateRequestSummary(requests, lensEvent.RequestId, lensEvent.TurnId);
                            request.Kind = "tool_user_input";
                            request.KindLabel = "User input";
                            request.State = "resolved";
                            request.Answers = lensEvent.UserInputResolved.Answers.Select(CloneAnsweredQuestion).ToList();
                            request.UpdatedAt = lensEvent.CreatedAt;
                        }
                        break;

                    case "runtime.warning":
                    case "runtime.error":
                        if (lensEvent.RuntimeMessage is not null)
                        {
                            notices.Add(new LensPulseRuntimeNotice
                            {
                                EventId = lensEvent.EventId,
                                Type = lensEvent.Type,
                                Message = lensEvent.RuntimeMessage.Message,
                                Detail = lensEvent.RuntimeMessage.Detail,
                                CreatedAt = lensEvent.CreatedAt
                            });
                            if (lensEvent.Type == "runtime.error")
                            {
                                snapshot.Session.LastError = lensEvent.RuntimeMessage.Message;
                            }
                        }
                        break;
                }
            }

            snapshot.Streams.AssistantText = assistant.ToString();
            snapshot.Streams.ReasoningText = reasoning.ToString();
            snapshot.Streams.ReasoningSummaryText = reasoningSummary.ToString();
            snapshot.Streams.PlanText = plan.ToString();
            snapshot.Streams.CommandOutput = commandOutput.ToString();
            snapshot.Streams.FileChangeOutput = fileChangeOutput.ToString();
            snapshot.Items = items.Values.OrderByDescending(i => i.UpdatedAt).ToList();
            snapshot.Requests = requests.Values.OrderByDescending(r => r.UpdatedAt).ToList();
            snapshot.Notices = notices.OrderByDescending(n => n.CreatedAt).ToList();
            return snapshot;
        }
    }

    public void Forget(string sessionId)
    {
        if (_logs.TryRemove(sessionId, out var log))
        {
            lock (log.SyncRoot)
            {
                foreach (var subscriber in log.Subscribers)
                {
                    subscriber.Writer.TryComplete();
                }

                log.Subscribers.Clear();
            }
        }
    }

    private static void ApplySessionState(LensPulseSnapshotResponse snapshot, LensPulseEvent lensEvent)
    {
        if (lensEvent.SessionState is null)
        {
            return;
        }

        snapshot.Session.State = lensEvent.SessionState.State;
        snapshot.Session.StateLabel = lensEvent.SessionState.StateLabel;
        snapshot.Session.Reason = lensEvent.SessionState.Reason;
        if (string.Equals(lensEvent.SessionState.State, "error", StringComparison.OrdinalIgnoreCase))
        {
            snapshot.Session.LastError = lensEvent.SessionState.Reason;
        }
    }

    private static void ApplyThreadState(LensPulseSnapshotResponse snapshot, LensPulseEvent lensEvent)
    {
        if (lensEvent.ThreadState is null)
        {
            return;
        }

        snapshot.Thread.State = lensEvent.ThreadState.State;
        snapshot.Thread.StateLabel = lensEvent.ThreadState.StateLabel;
        if (!string.IsNullOrWhiteSpace(lensEvent.ThreadState.ProviderThreadId))
        {
            snapshot.Thread.ThreadId = lensEvent.ThreadState.ProviderThreadId;
        }
    }

    private static void ApplyContentDelta(
        LensPulseEvent lensEvent,
        StringBuilder assistant,
        StringBuilder reasoning,
        StringBuilder reasoningSummary,
        StringBuilder plan,
        StringBuilder commandOutput,
        StringBuilder fileChangeOutput)
    {
        if (lensEvent.ContentDelta is null)
        {
            return;
        }

        switch (lensEvent.ContentDelta.StreamKind)
        {
            case "assistant_text":
                assistant.Append(lensEvent.ContentDelta.Delta);
                break;
            case "reasoning_text":
                reasoning.Append(lensEvent.ContentDelta.Delta);
                break;
            case "reasoning_summary_text":
                reasoningSummary.Append(lensEvent.ContentDelta.Delta);
                break;
            case "plan_text":
                plan.Append(lensEvent.ContentDelta.Delta);
                break;
            case "command_output":
                commandOutput.Append(lensEvent.ContentDelta.Delta);
                break;
            case "file_change_output":
                fileChangeOutput.Append(lensEvent.ContentDelta.Delta);
                break;
        }
    }

    private static LensPulseRequestSummary GetOrCreateRequestSummary(
        IDictionary<string, LensPulseRequestSummary> requests,
        string requestId,
        string? turnId)
    {
        if (!requests.TryGetValue(requestId, out var request))
        {
            request = new LensPulseRequestSummary
            {
                RequestId = requestId,
                TurnId = turnId,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            requests[requestId] = request;
        }

        return request;
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

    private static LensPulseEvent CloneEvent(LensPulseEvent source)
    {
        return new LensPulseEvent
        {
            Sequence = source.Sequence,
            EventId = source.EventId,
            SessionId = source.SessionId,
            Provider = source.Provider,
            ThreadId = source.ThreadId,
            TurnId = source.TurnId,
            ItemId = source.ItemId,
            RequestId = source.RequestId,
            CreatedAt = source.CreatedAt,
            Type = source.Type,
            Raw = source.Raw is null ? null : new LensPulseEventRaw
            {
                Source = source.Raw.Source,
                Method = source.Raw.Method,
                PayloadJson = source.Raw.PayloadJson
            },
            SessionState = source.SessionState is null ? null : new LensPulseSessionStatePayload
            {
                State = source.SessionState.State,
                StateLabel = source.SessionState.StateLabel,
                Reason = source.SessionState.Reason
            },
            ThreadState = source.ThreadState is null ? null : new LensPulseThreadStatePayload
            {
                State = source.ThreadState.State,
                StateLabel = source.ThreadState.StateLabel,
                ProviderThreadId = source.ThreadState.ProviderThreadId
            },
            TurnStarted = source.TurnStarted is null ? null : new LensPulseTurnStartedPayload
            {
                Model = source.TurnStarted.Model,
                Effort = source.TurnStarted.Effort
            },
            TurnCompleted = source.TurnCompleted is null ? null : new LensPulseTurnCompletedPayload
            {
                State = source.TurnCompleted.State,
                StateLabel = source.TurnCompleted.StateLabel,
                StopReason = source.TurnCompleted.StopReason,
                ErrorMessage = source.TurnCompleted.ErrorMessage
            },
            ContentDelta = source.ContentDelta is null ? null : new LensPulseContentDeltaPayload
            {
                StreamKind = source.ContentDelta.StreamKind,
                Delta = source.ContentDelta.Delta
            },
            PlanDelta = source.PlanDelta is null ? null : new LensPulsePlanDeltaPayload
            {
                Delta = source.PlanDelta.Delta
            },
            PlanCompleted = source.PlanCompleted is null ? null : new LensPulsePlanCompletedPayload
            {
                PlanMarkdown = source.PlanCompleted.PlanMarkdown
            },
            DiffUpdated = source.DiffUpdated is null ? null : new LensPulseDiffUpdatedPayload
            {
                UnifiedDiff = source.DiffUpdated.UnifiedDiff
            },
            Item = source.Item is null ? null : new LensPulseItemPayload
            {
                ItemType = source.Item.ItemType,
                Status = source.Item.Status,
                Title = source.Item.Title,
                Detail = source.Item.Detail,
                Attachments = CloneAttachments(source.Item.Attachments)
            },
            RequestOpened = source.RequestOpened is null ? null : new LensPulseRequestOpenedPayload
            {
                RequestType = source.RequestOpened.RequestType,
                RequestTypeLabel = source.RequestOpened.RequestTypeLabel,
                Detail = source.RequestOpened.Detail
            },
            RequestResolved = source.RequestResolved is null ? null : new LensPulseRequestResolvedPayload
            {
                RequestType = source.RequestResolved.RequestType,
                Decision = source.RequestResolved.Decision
            },
            UserInputRequested = source.UserInputRequested is null ? null : new LensPulseUserInputRequestedPayload
            {
                Questions = source.UserInputRequested.Questions.Select(CloneQuestion).ToList()
            },
            UserInputResolved = source.UserInputResolved is null ? null : new LensPulseUserInputResolvedPayload
            {
                Answers = source.UserInputResolved.Answers.Select(CloneAnsweredQuestion).ToList()
            },
            RuntimeMessage = source.RuntimeMessage is null ? null : new LensPulseRuntimeMessagePayload
            {
                Message = source.RuntimeMessage.Message,
                Detail = source.RuntimeMessage.Detail
            }
        };
    }

    private static LensPulseQuestion CloneQuestion(LensPulseQuestion source)
    {
        return new LensPulseQuestion
        {
            Id = source.Id,
            Header = source.Header,
            Question = source.Question,
            MultiSelect = source.MultiSelect,
            Options = source.Options.Select(option => new LensPulseQuestionOption
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

    private static string NormalizeItemType(string? itemType)
    {
        return (itemType ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "usermessage" => "user_message",
            _ => itemType ?? string.Empty
        };
    }

    private static bool TryFindLocalUserMessageItem(
        IReadOnlyDictionary<string, LensPulseItemSummary> items,
        string? turnId,
        out string itemId)
    {
        if (!string.IsNullOrWhiteSpace(turnId))
        {
            foreach (var pair in items)
            {
                if (pair.Key.StartsWith("local-user:", StringComparison.Ordinal) &&
                    string.Equals(pair.Value.TurnId, turnId, StringComparison.Ordinal))
                {
                    itemId = pair.Key;
                    return true;
                }
            }
        }

        itemId = string.Empty;
        return false;
    }

    private static string ChoosePreferredUserMessageStatus(string? existingStatus, string? incomingStatus)
    {
        if (string.Equals(existingStatus, "completed", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(incomingStatus, "completed", StringComparison.OrdinalIgnoreCase))
        {
            return "completed";
        }

        return string.IsNullOrWhiteSpace(incomingStatus) ? existingStatus ?? string.Empty : incomingStatus;
    }

    private static List<LensAttachmentReference> CloneAttachments(
        IReadOnlyList<LensAttachmentReference>? attachments)
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

    private sealed class SessionLensPulseLog
    {
        public SessionLensPulseLog(string sessionId)
        {
            SessionId = sessionId;
        }

        public string SessionId { get; }
        public Lock SyncRoot { get; } = new();
        public long NextSequence { get; set; }
        public List<LensPulseEvent> Events { get; } = [];
        public List<LensPulseSubscriber> Subscribers { get; } = [];
    }

    private sealed class LensPulseSubscriber(ChannelWriter<LensPulseEvent> writer)
    {
        public ChannelWriter<LensPulseEvent> Writer { get; } = writer;
    }
}

public sealed class LensPulseSubscription : IDisposable
{
    private readonly Action _dispose;
    private int _disposed;

    public LensPulseSubscription(ChannelReader<LensPulseEvent> reader, Action dispose)
    {
        Reader = reader;
        _dispose = dispose;
    }

    public ChannelReader<LensPulseEvent> Reader { get; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            _dispose();
        }
    }
}
