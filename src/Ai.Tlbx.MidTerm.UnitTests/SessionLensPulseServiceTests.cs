using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionLensPulseServiceTests
{
    [Fact]
    public void GetSnapshot_ReducesCanonicalLensEventsIntoRenderState()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "e1",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:00Z"),
            Type = "session.started",
            SessionState = new LensPulseSessionStatePayload
            {
                State = "starting",
                StateLabel = "Starting",
                Reason = "Booting"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e2",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:01Z"),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload
            {
                Model = "gpt-5.3-codex",
                Effort = "medium"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e3",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "local-user:turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:01.5000000Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "user_message",
                Status = "completed",
                Title = "User message",
                Detail = "Inspect this screenshot.",
                Attachments =
                [
                    new LensAttachmentReference
                    {
                        Kind = "image",
                        Path = "Q:/repo/.midterm/uploads/screenshot.png",
                        MimeType = "image/png",
                        DisplayName = "screenshot.png"
                    }
                ]
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e4",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            ItemId = "item-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:02Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = "hello"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e5",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            RequestId = "req-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:03Z"),
            Type = "user-input.requested",
            UserInputRequested = new LensPulseUserInputRequestedPayload
            {
                Questions =
                [
                    new LensPulseQuestion
                    {
                        Id = "q1",
                        Header = "Mode",
                        Question = "Pick mode",
                        Options = [new LensPulseQuestionOption { Label = "A", Description = "alpha" }]
                    }
                ]
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e6",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            ItemId = "item-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:03Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "reasoning_text",
                Delta = "thinking"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e7",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            ItemId = "item-3",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:03Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "command_output",
                Delta = "npm test"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e8",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            RequestId = "approval-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:03Z"),
            Type = "request.opened",
            RequestOpened = new LensPulseRequestOpenedPayload
            {
                RequestType = "command_execution_approval",
                RequestTypeLabel = "Command approval",
                Detail = "npm test"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e9",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            RequestId = "approval-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:04Z"),
            Type = "request.resolved",
            RequestResolved = new LensPulseRequestResolvedPayload
            {
                RequestType = "command_execution_approval",
                Decision = "accept"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e10",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:05Z"),
            Type = "diff.updated",
            DiffUpdated = new LensPulseDiffUpdatedPayload
            {
                UnifiedDiff = "--- a\n+++ b"
            }
        });

        var snapshot = service.GetSnapshot("s1");

        Assert.NotNull(snapshot);
        Assert.Equal("codex", snapshot!.Provider);
        Assert.Equal("starting", snapshot.Session.State);
        Assert.Equal("turn-1", snapshot.CurrentTurn.TurnId);
        Assert.Equal("hello", snapshot.Streams.AssistantText);
        Assert.Equal("thinking", snapshot.Streams.ReasoningText);
        Assert.Equal("npm test", snapshot.Streams.CommandOutput);
        Assert.Equal("--- a\n+++ b", snapshot.Streams.UnifiedDiff);
        Assert.Contains(
            snapshot.Items,
            item => item.ItemType == "user_message" &&
                    item.Detail == "Inspect this screenshot." &&
                    item.Attachments.Count == 1 &&
                    item.Attachments[0].DisplayName == "screenshot.png");
        Assert.Equal(2, snapshot.Requests.Count);
        Assert.Contains(snapshot.Requests, request => request.Kind == "tool_user_input" && request.Questions.Count == 1);
        Assert.Contains(snapshot.Requests, request => request.Kind == "command_execution_approval" && request.Decision == "accept");
    }

    [Fact]
    public void GetEvents_FiltersBySequence()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "e1",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.UtcNow,
            Type = "session.started"
        });
        service.Append(new LensPulseEvent
        {
            EventId = "e2",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.UtcNow,
            Type = "session.ready"
        });

        var all = service.GetEvents("s1");
        var afterFirst = service.GetEvents("s1", 1);

        Assert.Equal(2, all.LatestSequence);
        Assert.Equal(2, all.Events.Count);
        Assert.Single(afterFirst.Events);
        Assert.Equal("e2", afterFirst.Events[0].EventId);
    }

    [Fact]
    public void GetSnapshotWindow_ReturnsTailWindowMetadata()
    {
        var service = new SessionLensPulseService();

        for (var i = 0; i < 12; i += 1)
        {
            service.Append(new LensPulseEvent
            {
                EventId = $"e{i}",
                SessionId = "s-window",
                Provider = "codex",
                ThreadId = "thread-window",
                ItemId = $"item-{i}",
                CreatedAt = DateTimeOffset.Parse("2026-03-20T14:00:00Z").AddSeconds(i),
                Type = "item.completed",
                Item = new LensPulseItemPayload
                {
                    ItemType = i % 2 == 0 ? "user_message" : "assistant_message",
                    Status = "completed",
                    Title = "Message",
                    Detail = $"entry-{i}"
                }
            });
        }

        var snapshot = service.GetSnapshotWindow("s-window", count: 5);

        Assert.NotNull(snapshot);
        Assert.Equal(12, snapshot!.TotalHistoryCount);
        Assert.Equal(7, snapshot.HistoryWindowStart);
        Assert.Equal(12, snapshot.HistoryWindowEnd);
        Assert.True(snapshot.HasOlderHistory);
        Assert.False(snapshot.HasNewerHistory);
        Assert.Equal(5, snapshot.Transcript.Count);
        Assert.Equal("entry-7", snapshot.Transcript[0].Body);
        Assert.Equal("entry-11", snapshot.Transcript[^1].Body);
    }

    [Fact]
    public void GetSnapshot_ResetsStreamingBuffersWhenANewTurnStarts()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "t1-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T01:00:00Z"),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload()
        });
        service.Append(new LensPulseEvent
        {
            EventId = "t1-delta",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T01:00:01Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = "first turn"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "t1-complete",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T01:00:02Z"),
            Type = "turn.completed",
            TurnCompleted = new LensPulseTurnCompletedPayload
            {
                State = "completed",
                StateLabel = "Completed"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "t2-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T01:00:03Z"),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload()
        });
        service.Append(new LensPulseEvent
        {
            EventId = "t2-delta",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T01:00:04Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = "second turn"
            }
        });

        var snapshot = service.GetSnapshot("s1");

        Assert.NotNull(snapshot);
        Assert.Equal("turn-2", snapshot!.CurrentTurn.TurnId);
        Assert.Equal("second turn", snapshot.Streams.AssistantText);
    }

    [Fact]
    public void GetSnapshot_ReconcilesProviderUserMessageWithSubmittedLocalUserTurn()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "local-user",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "local-user:turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T02:00:00Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "user_message",
                Status = "completed",
                Title = "User message",
                Detail = "which working dir are you in"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "provider-user",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "provider-item-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-22T02:00:01Z"),
            Type = "item.started",
            Item = new LensPulseItemPayload
            {
                ItemType = "usermessage",
                Status = "in_progress",
                Title = "Tool started",
                Detail = string.Empty
            }
        });

        var snapshot = service.GetSnapshot("s1");

        Assert.NotNull(snapshot);
        var userItems = snapshot!.Items.Where(item => item.ItemType == "user_message").ToList();
        var userItem = Assert.Single(userItems);
        Assert.Equal("local-user:turn-1", userItem.ItemId);
        Assert.Equal("turn-1", userItem.TurnId);
        Assert.Equal("completed", userItem.Status);
        Assert.Equal("which working dir are you in", userItem.Detail);
    }

    [Fact]
    public void GetSnapshot_PreservesEarlierTurnsWhenALaterTurnCompletes()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "turn-1-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:00:00Z"),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload()
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-1-user",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "local-user:turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:00:01Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "user_message",
                Status = "completed",
                Detail = "first question"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-1-assistant",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:00:02Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = "first answer"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-1-complete",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:00:03Z"),
            Type = "turn.completed",
            TurnCompleted = new LensPulseTurnCompletedPayload
            {
                State = "completed",
                StateLabel = "Completed"
            }
        });

        service.Append(new LensPulseEvent
        {
            EventId = "turn-2-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:01:00Z"),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload()
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-2-user",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            ItemId = "local-user:turn-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:01:01Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "user_message",
                Status = "completed",
                Detail = "second question"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-2-assistant-delta",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:01:02Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = "second answer"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-2-assistant-final",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            ItemId = "assistant-item-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:01:03Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "assistant_message",
                Status = "completed",
                Detail = "second answer final"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "turn-2-complete",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-2",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T10:01:04Z"),
            Type = "turn.completed",
            TurnCompleted = new LensPulseTurnCompletedPayload
            {
                State = "completed",
                StateLabel = "Completed"
            }
        });

        var snapshot = service.GetSnapshot("s1");

        Assert.NotNull(snapshot);
        var transcript = snapshot!.Transcript;
        Assert.Equal(5, transcript.Count);
        Assert.Collection(
            transcript,
            entry =>
            {
                Assert.Equal("user", entry.Kind);
                Assert.Equal("turn-1", entry.TurnId);
                Assert.Equal("first question", entry.Body);
            },
            entry =>
            {
                Assert.Equal("assistant", entry.Kind);
                Assert.Equal("turn-1", entry.TurnId);
                Assert.Equal("first answer", entry.Body);
            },
            entry =>
            {
                Assert.Equal("user", entry.Kind);
                Assert.Equal("turn-2", entry.TurnId);
                Assert.Equal("second question", entry.Body);
            },
            entry =>
            {
                Assert.Equal("assistant", entry.Kind);
                Assert.Equal("turn-2", entry.TurnId);
                Assert.Equal("assistant-stream:turn-2", entry.EntryId);
                Assert.Equal("second answer", entry.Body);
            },
            entry =>
            {
                Assert.Equal("assistant", entry.Kind);
                Assert.Equal("turn-2", entry.TurnId);
                Assert.Equal("assistant:assistant-item-2", entry.EntryId);
                Assert.Equal("second answer final", entry.Body);
            });
    }

    [Fact]
    public void GetSnapshot_PreservesAssistantChronologyWhenFinalItemArrivesAfterToolWork()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "turn-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T11:00:00Z"),
            Type = "turn.started",
            TurnStarted = new LensPulseTurnStartedPayload()
        });
        service.Append(new LensPulseEvent
        {
            EventId = "assistant-delta-1",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T11:00:01Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "assistant_text",
                Delta = "I will inspect the directory first."
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "tool-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "tool-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T11:00:02Z"),
            Type = "item.started",
            Item = new LensPulseItemPayload
            {
                ItemType = "command",
                Status = "in_progress",
                Title = "List files",
                Detail = "Get-ChildItem"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "assistant-final",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "assistant-item-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T11:00:03Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "assistant_message",
                Status = "completed",
                Detail = "Here is the final table."
            }
        });

        var snapshot = service.GetSnapshot("s1");

        Assert.NotNull(snapshot);
        var assistantEntries = snapshot!.Transcript.Where(entry => entry.Kind == "assistant").ToList();
        Assert.Equal(2, assistantEntries.Count);
        Assert.Collection(
            snapshot.Transcript.Where(entry => entry.Kind is "assistant" or "tool"),
            entry =>
            {
                Assert.Equal("assistant", entry.Kind);
                Assert.Equal("assistant-stream:turn-1", entry.EntryId);
                Assert.Equal("I will inspect the directory first.", entry.Body);
                Assert.True(entry.Streaming);
            },
            entry =>
            {
                Assert.Equal("tool", entry.Kind);
                Assert.Equal("tool:tool-1", entry.EntryId);
            },
            entry =>
            {
                Assert.Equal("assistant", entry.Kind);
                Assert.Equal("assistant:assistant-item-1", entry.EntryId);
                Assert.Equal("Here is the final table.", entry.Body);
                Assert.False(entry.Streaming);
                Assert.Equal("completed", entry.Status);
            });
    }

    [Fact]
    public void GetSnapshot_MergesToolLifecycleIntoSingleTranscriptRow()
    {
        var service = new SessionLensPulseService();

        service.Append(new LensPulseEvent
        {
            EventId = "tool-start",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "tool-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T12:00:00Z"),
            Type = "item.started",
            Item = new LensPulseItemPayload
            {
                ItemType = "command",
                Status = "in_progress",
                Title = "Run tests",
                Detail = "npm test"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "tool-output",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "tool-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T12:00:01Z"),
            Type = "content.delta",
            ContentDelta = new LensPulseContentDeltaPayload
            {
                StreamKind = "command_output",
                Delta = "All green"
            }
        });
        service.Append(new LensPulseEvent
        {
            EventId = "tool-complete",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            TurnId = "turn-1",
            ItemId = "tool-1",
            CreatedAt = DateTimeOffset.Parse("2026-03-27T12:00:02Z"),
            Type = "item.completed",
            Item = new LensPulseItemPayload
            {
                ItemType = "command",
                Status = "completed",
                Title = "Run tests",
                Detail = "npm test"
            }
        });

        var snapshot = service.GetSnapshot("s1");

        Assert.NotNull(snapshot);
        var toolEntries = snapshot!.Transcript.Where(entry => entry.Kind == "tool").ToList();
        var tool = Assert.Single(toolEntries);
        Assert.Equal("tool:tool-1", tool.EntryId);
        Assert.Equal("Run tests", tool.Title);
        Assert.Contains("npm test", tool.Body);
        Assert.Contains("All green", tool.Body);
        Assert.False(tool.Streaming);
    }

    [Fact]
    public async Task Subscribe_ReplaysBacklogAndStreamsFutureEvents()
    {
        var service = new SessionLensPulseService();
        service.Append(new LensPulseEvent
        {
            EventId = "e1",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.UtcNow,
            Type = "session.started"
        });

        using var subscription = service.Subscribe("s1", afterSequence: 0);
        Assert.True(await subscription.Reader.WaitToReadAsync());
        Assert.True(subscription.Reader.TryRead(out var backlogEvent));
        Assert.Equal("e1", backlogEvent!.EventId);

        service.Append(new LensPulseEvent
        {
            EventId = "e2",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.UtcNow,
            Type = "session.ready"
        });

        Assert.True(await subscription.Reader.WaitToReadAsync());
        Assert.True(subscription.Reader.TryRead(out var liveEvent));
        Assert.Equal("e2", liveEvent!.EventId);
        Assert.Equal(2, liveEvent.Sequence);
    }

    [Fact]
    public void HasHistory_TracksWhetherCanonicalLensEventsExist()
    {
        var service = new SessionLensPulseService();

        Assert.False(service.HasHistory("s1"));

        service.Append(new LensPulseEvent
        {
            EventId = "e1",
            SessionId = "s1",
            Provider = "codex",
            ThreadId = "thread-1",
            CreatedAt = DateTimeOffset.UtcNow,
            Type = "session.started"
        });

        Assert.True(service.HasHistory("s1"));
        Assert.False(service.HasHistory("s2"));
    }
}
