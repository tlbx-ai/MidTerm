using System.Globalization;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class ManagerBarQueueServiceTests : IAsyncDisposable
{
    private readonly string _stateDir;
    private readonly FakeTimeProvider _timeProvider;

    public ManagerBarQueueServiceTests()
    {
        _stateDir = Path.Combine(Path.GetTempPath(), "midterm-manager-bar-queue-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_stateDir);
        _timeProvider = new FakeTimeProvider(DateTimeOffset.Parse("2026-04-04T12:00:00Z", CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task Enqueue_PersistsAcrossRestart()
    {
        var runtime = new FakeRuntime(["session-1"]);
        await using (var initial = new ManagerBarQueueService(_stateDir, runtime, _timeProvider))
        {
            var entry = initial.Enqueue("session-1", new ManagerBarButton
            {
                Id = "build",
                Label = "Build",
                ActionType = "single",
                Prompts = ["dotnet build"],
                Trigger = new ManagerBarTrigger
                {
                    Kind = "repeatCount",
                    RepeatCount = 3
                }
            });

            Assert.NotNull(entry);
            Assert.Single(initial.GetSnapshot(["session-1"]));
        }

        await using var restarted = new ManagerBarQueueService(_stateDir, runtime, _timeProvider);
        var snapshot = Assert.Single(restarted.GetSnapshot(["session-1"]));
        Assert.Equal("session-1", snapshot.SessionId);
        Assert.Equal("Build", snapshot.Action.Label);
        Assert.Equal("repeatCount", snapshot.Action.Trigger.Kind);
        Assert.Equal("pendingCooldown", snapshot.Phase);
    }

    [Fact]
    public async Task GetSnapshot_FiltersQueueEntriesToValidSessions()
    {
        var runtime = new FakeRuntime(["session-1", "session-2"]);
        await using var service = new ManagerBarQueueService(_stateDir, runtime, _timeProvider);

        service.Enqueue("session-1", new ManagerBarButton
        {
            Label = "One",
            Prompts = ["echo one"],
            Trigger = new ManagerBarTrigger { Kind = "onCooldown" }
        });
        service.Enqueue("session-2", new ManagerBarButton
        {
            Label = "Two",
            Prompts = ["echo two"],
            Trigger = new ManagerBarTrigger { Kind = "repeatInterval", RepeatEveryValue = 5 }
        });

        var filtered = service.GetSnapshot(["session-2"]);

        var entry = Assert.Single(filtered);
        Assert.Equal("session-2", entry.SessionId);
        Assert.Equal("Two", entry.Action.Label);
    }

    [Fact]
    public async Task Enqueue_DeduplicatesBurstRequestsForSameAction()
    {
        var runtime = new FakeRuntime(["session-1"]);
        await using var service = new ManagerBarQueueService(_stateDir, runtime, _timeProvider);
        var action = CreateRepeatCountAction();

        var first = service.Enqueue("session-1", action);
        var second = service.Enqueue("session-1", action);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.Equal(first!.QueueId, second!.QueueId);
        Assert.Single(service.GetSnapshot(["session-1"]));
    }

    [Fact]
    public async Task Enqueue_AllowsSameActionAgainAfterDedupWindowExpires()
    {
        var runtime = new FakeRuntime(["session-1"]);
        await using var service = new ManagerBarQueueService(_stateDir, runtime, _timeProvider);
        var action = CreateRepeatCountAction();

        var first = service.Enqueue("session-1", action);
        _timeProvider.Advance(TimeSpan.FromSeconds(2));
        var second = service.Enqueue("session-1", action);

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.NotEqual(first!.QueueId, second!.QueueId);
        Assert.Equal(2, service.GetSnapshot(["session-1"]).Count);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (Directory.Exists(_stateDir))
            {
                Directory.Delete(_stateDir, recursive: true);
            }
        }
        catch
        {
        }

        await ValueTask.CompletedTask;
    }

    private static ManagerBarButton CreateRepeatCountAction()
    {
        return new ManagerBarButton
        {
            Id = "build",
            Label = "Build",
            ActionType = "single",
            Prompts = ["dotnet build"],
            Trigger = new ManagerBarTrigger
            {
                Kind = "repeatCount",
                RepeatCount = 3
            }
        };
    }

    private sealed class FakeRuntime : IManagerBarQueueRuntime
    {
        private readonly HashSet<string> _sessionIds;

        public FakeRuntime(IEnumerable<string> sessionIds)
        {
            _sessionIds = new HashSet<string>(sessionIds, StringComparer.Ordinal);
        }

        public IReadOnlyCollection<string> GetActiveSessionIds()
        {
            return _sessionIds.ToArray();
        }

        public bool SessionExists(string sessionId)
        {
            return _sessionIds.Contains(sessionId);
        }

        public double GetCurrentHeat(string sessionId)
        {
            return 0;
        }

        public Task SendPromptAsync(string sessionId, string prompt, CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }
    }
}
