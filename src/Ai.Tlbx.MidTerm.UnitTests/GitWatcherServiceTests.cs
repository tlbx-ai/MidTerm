using Ai.Tlbx.MidTerm.Services.Git;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class GitWatcherServiceTests
{
    [Fact]
    public void MultipleBrowserSubscriptions_AreReferenceCountedPerSession()
    {
        using var watcher = new GitWatcherService();
        watcher.ConfigureSessionValidator(static _ => true);

        watcher.Subscribe("session-1");
        watcher.Subscribe("session-1");
        Assert.Equal(2, watcher.GetSessionSubscriberCountForTests("session-1"));

        watcher.Unsubscribe("session-1");
        Assert.Equal(1, watcher.GetSessionSubscriberCountForTests("session-1"));

        watcher.Unsubscribe("session-1");
        Assert.Equal(0, watcher.GetSessionSubscriberCountForTests("session-1"));
    }

    [Fact]
    public async Task ClosedSession_CannotStartOrRestoreGitMonitoring()
    {
        using var watcher = new GitWatcherService();
        watcher.ConfigureSessionValidator(static _ => false);

        await watcher.RegisterSessionAsync("closed", Environment.CurrentDirectory);
        watcher.Subscribe("closed");

        Assert.Null(watcher.GetRepoRoot("closed"));
        Assert.Empty(watcher.GetRepoBindings("closed"));
        Assert.Equal(0, watcher.GetSessionSubscriberCountForTests("closed"));
    }

    [Fact]
    public async Task ConcurrentSubscriptions_ReturnToZeroWithoutUnderflow()
    {
        using var watcher = new GitWatcherService();
        watcher.ConfigureSessionValidator(static _ => true);

        await Task.WhenAll(Enumerable.Range(0, 100).Select(_ => Task.Run(() => watcher.Subscribe("session-1"))));
        Assert.Equal(100, watcher.GetSessionSubscriberCountForTests("session-1"));

        await Task.WhenAll(Enumerable.Range(0, 100).Select(_ => Task.Run(() => watcher.Unsubscribe("session-1"))));
        Assert.Equal(0, watcher.GetSessionSubscriberCountForTests("session-1"));
    }

    [Fact]
    public async Task RepeatedUnregister_CanBeAwaitedWithoutLosingCleanupBarrier()
    {
        using var watcher = new GitWatcherService();
        watcher.ConfigureSessionValidator(static _ => true);

        watcher.UnregisterSession("session-1");
        watcher.UnregisterSession("session-1");

        await watcher.WaitForSessionCleanupAsync("session-1").WaitAsync(TimeSpan.FromSeconds(2));
        Assert.Null(watcher.GetRepoRoot("session-1"));
    }
}
