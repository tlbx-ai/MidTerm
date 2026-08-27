using Ai.Tlbx.MidTerm.Common.Protocol;
using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SessionLaunchCoordinatorTests
{
    [Fact]
    public async Task ConcurrentRetries_JoinOneLaunchOperation()
    {
        var coordinator = new SessionLaunchCoordinator(TimeProvider.System, TimeSpan.FromSeconds(1));
        var launchCount = 0;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<SessionCreationResult> Launch(CancellationToken ct)
        {
            Interlocked.Increment(ref launchCount);
            await release.Task.WaitAsync(ct);
            return SessionCreationResult.Success(new SessionInfo { Id = "session-1" });
        }

        var first = coordinator.RunAsync("launch-1", "same", Launch, CancellationToken.None);
        var second = coordinator.RunAsync("launch-1", "same", Launch, CancellationToken.None);
        release.SetResult();

        var results = await Task.WhenAll(first, second);

        Assert.Equal(1, launchCount);
        Assert.All(results, result => Assert.Equal("session-1", result.Session?.Id));
    }

    [Fact]
    public async Task RequestCancellation_DoesNotCancelOwnedLaunchAndRetryCanReconcile()
    {
        var coordinator = new SessionLaunchCoordinator(TimeProvider.System, TimeSpan.FromSeconds(1));
        var launchCount = 0;
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task<SessionCreationResult> Launch(CancellationToken ct)
        {
            Interlocked.Increment(ref launchCount);
            await release.Task.WaitAsync(ct);
            return SessionCreationResult.Success(new SessionInfo { Id = "session-after-reconnect" });
        }

        using var requestCancellation = new CancellationTokenSource();
        var disconnectedRequest = coordinator.RunAsync(
            "launch-reconnect",
            "same",
            Launch,
            requestCancellation.Token);
        requestCancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => disconnectedRequest);

        var retry = coordinator.RunAsync(
            "launch-reconnect",
            "same",
            Launch,
            CancellationToken.None);
        release.SetResult();
        var result = await retry;

        Assert.Equal(1, launchCount);
        Assert.Equal("session-after-reconnect", result.Session?.Id);
    }

    [Fact]
    public async Task ReusedIdWithDifferentPayload_IsRejectedWithoutSecondLaunch()
    {
        var coordinator = new SessionLaunchCoordinator(TimeProvider.System, TimeSpan.FromSeconds(1));
        var launchCount = 0;
        Task<SessionCreationResult> Launch(CancellationToken _)
        {
            launchCount++;
            return Task.FromResult(SessionCreationResult.Success(new SessionInfo { Id = "session-1" }));
        }

        var first = await coordinator.RunAsync("launch-1", "payload-a", Launch, CancellationToken.None);
        var conflicting = await coordinator.RunAsync("launch-1", "payload-b", Launch, CancellationToken.None);

        Assert.True(first.Succeeded);
        Assert.False(conflicting.Succeeded);
        Assert.Equal("idempotency", conflicting.Failure?.Stage);
        Assert.Equal(1, launchCount);
    }

    [Fact]
    public async Task OwnedLaunchTimeout_IsBoundedAndReported()
    {
        var coordinator = new SessionLaunchCoordinator(TimeProvider.System, TimeSpan.FromMilliseconds(40));

        var result = await coordinator.RunAsync(
            "launch-timeout",
            "same",
            async ct =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                throw new InvalidOperationException("unreachable");
            },
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("timeout", result.Failure?.Stage);
    }
}
