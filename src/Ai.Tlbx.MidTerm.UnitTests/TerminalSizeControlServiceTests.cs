using Ai.Tlbx.MidTerm.Services.Sessions;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class TerminalSizeControlServiceTests
{

    [Fact]
    public async Task Interaction_DoesNotTakeOverFreshOnlineOwner()
    {
        using var fixture = new Fixture();
        var ownerConnection = new object();
        fixture.Service.RegisterBrowser("browser-a:tab-1", ownerConnection);
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);

        var result = await fixture.Service.RecordInputAsync("session-1", "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.False(result.OwnershipChanged);
        Assert.False(result.Status.IsOwner);
        Assert.True(result.Status.OwnerOnline);
    }

    [Fact]
    public async Task Interaction_TakesOverDifferentOnlineDeviceAfterProtectionWindow()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("browser-a:tab-1", new object());
        fixture.Service.RegisterBrowser("browser-b:tab-2", new object());
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TerminalSizeControlService.ConnectedOwnerProtectionDelay);

        var result = await fixture.Service.RecordInputAsync("session-1", "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.True(result.OwnershipChanged);
        Assert.True(result.Status.IsOwner);
        Assert.True(result.Status.OwnerOnline);
    }

    [Fact]
    public async Task ConnectedSiblingTab_NeverAutomaticallyStealsAfterProtectionWindow()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("browser-a:tab-1", new object());
        fixture.Service.RegisterBrowser("browser-a:tab-2", new object());
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TerminalSizeControlService.ConnectedOwnerProtectionDelay);

        var result = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-a:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.False(result.OwnershipChanged);
        Assert.False(result.Status.IsOwner);
        Assert.True(result.Status.OwnerOnline);
        Assert.True(result.Status.OwnerInSameBrowserProfile);
    }

    [Fact]
    public async Task Interaction_TakesOverOfflineOwnerAfterShortGracePeriod()
    {
        using var fixture = new Fixture();
        var ownerConnection = new object();
        fixture.Service.RegisterBrowser("browser-a:tab-1", ownerConnection);
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Service.UnregisterBrowser("browser-a:tab-1", ownerConnection);

        fixture.Time.Advance(TerminalSizeControlService.OfflineTakeoverDelay - TimeSpan.FromSeconds(1));
        var early = await fixture.Service.RecordInputAsync("session-1", "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);
        Assert.False(early.OwnershipChanged);

        fixture.Time.Advance(TimeSpan.FromSeconds(1));
        var eligible = await fixture.Service.RecordInputAsync("session-1", "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.True(eligible.OwnershipChanged);
        Assert.True(eligible.Status.IsOwner);
    }

    [Fact]
    public async Task IdleOwnerStillGetsFullOfflineGracePeriodFromDisconnect()
    {
        using var fixture = new Fixture();
        var ownerConnection = new object();
        fixture.Service.RegisterBrowser("browser-a:tab-1", ownerConnection);
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromHours(1));
        fixture.Service.UnregisterBrowser("browser-a:tab-1", ownerConnection);

        var immediate = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TerminalSizeControlService.OfflineTakeoverDelay);
        var afterGrace = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.False(immediate.OwnershipChanged);
        Assert.True(afterGrace.OwnershipChanged);
        Assert.True(afterGrace.Status.IsOwner);
    }

    [Fact]
    public async Task RestartedServiceGivesPersistedOwnerFreshOfflineGracePeriod()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("browser-a:tab-1", new object());
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromHours(1));
        fixture.RestartService();

        var immediate = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TerminalSizeControlService.OfflineTakeoverDelay);
        var afterGrace = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.False(immediate.OwnershipChanged);
        Assert.True(afterGrace.OwnershipChanged);
    }

    [Fact]
    public async Task ReopenedTabInSameBrowserProfile_InheritsOfflineOwnerImmediately()
    {
        using var fixture = new Fixture();
        var ownerConnection = new object();
        fixture.Service.RegisterBrowser("browser-a:tab-1", ownerConnection);
        await fixture.Service.RequestControlAsync(
            "session-1",
            "browser-a:tab-1",
            true,
            "Windows PC · Chrome", ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Service.UnregisterBrowser("browser-a:tab-1", ownerConnection);

        var result = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-a:tab-2",
            "Windows PC · Chrome", Xunit.TestContext.Current.CancellationToken);

        Assert.True(result.OwnershipChanged);
        Assert.True(result.Status.IsOwner);
        Assert.Equal("Windows PC · Chrome", result.Status.OwnerLabel);
    }

    [Fact]
    public async Task ExplicitClaim_ImmediatelyOverridesFreshOwner()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("browser-a:tab-1", new object());
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);

        var result = await fixture.Service.RequestControlAsync("session-1", "browser-b:tab-2", true, ct: Xunit.TestContext.Current.CancellationToken);

        Assert.True(result.OwnershipChanged);
        Assert.True(result.Status.IsOwner);
    }

    [Fact]
    public async Task ConcurrentExplicitClaimsWithOneObservedEpochHaveOneWinner()
    {
        using var fixture = new Fixture();
        var owner = await fixture.Service.RequestControlAsync(
            "session-1",
            "browser-a:tab-1",
            true, ct: Xunit.TestContext.Current.CancellationToken);

        var claims = await Task.WhenAll(
            fixture.Service.RequestControlAsync(
                "session-1",
                "browser-b:tab-2",
                true,
                expectedEpoch: owner.Status.Epoch, ct: Xunit.TestContext.Current.CancellationToken),
            fixture.Service.RequestControlAsync(
                "session-1",
                "browser-c:tab-3",
                true,
                expectedEpoch: owner.Status.Epoch, ct: Xunit.TestContext.Current.CancellationToken));

        Assert.Single(claims, result => result.OwnershipChanged);
        Assert.All(claims, result => Assert.Equal(owner.Status.Epoch + 1, result.Status.Epoch));
        var browserB = fixture.Service.GetStatus("session-1", "browser-b:tab-2");
        var browserC = fixture.Service.GetStatus("session-1", "browser-c:tab-3");
        Assert.NotEqual(browserB.IsOwner, browserC.IsOwner);
    }

    [Fact]
    public async Task ExplicitHandoff_DoesNotImmediatelyPingPongBack()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("browser-a:tab-1", new object());
        fixture.Service.RegisterBrowser("browser-b:tab-2", new object());
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        var handoff = await fixture.Service.RequestControlAsync(
            "session-1",
            "browser-b:tab-2",
            true, ct: Xunit.TestContext.Current.CancellationToken);
        var oldOwnerInput = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-a:tab-1", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.True(handoff.Status.IsOwner);
        Assert.False(oldOwnerInput.OwnershipChanged);
        Assert.False(oldOwnerInput.Status.IsOwner);
        Assert.Equal(handoff.Status.Epoch, oldOwnerInput.Status.Epoch);
    }

    [Fact]
    public async Task OwnerInput_RenewsConnectedLease()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("browser-a:tab-1", new object());
        await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromMinutes(4));
        await fixture.Service.RecordInputAsync("session-1", "browser-a:tab-1", ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromMinutes(2));

        var result = await fixture.Service.RecordInputAsync(
            "session-1",
            "browser-b:tab-2", ct: Xunit.TestContext.Current.CancellationToken);

        Assert.False(result.OwnershipChanged);
        Assert.False(result.Status.IsOwner);
    }

    [Fact]
    public async Task Resize_RequiresCurrentOwnerAndEpoch()
    {
        using var fixture = new Fixture();
        var owner = await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);
        var resizeCalls = 0;

        var accepted = await fixture.Service.ResizeAsync(
            "session-1",
            "browser-a:tab-1",
            owner.Status.Epoch,
            120,
            30,
            _ =>
            {
                resizeCalls++;
                return Task.FromResult(true);
            }, Xunit.TestContext.Current.CancellationToken);
        var stale = await fixture.Service.ResizeAsync(
            "session-1",
            "browser-a:tab-1",
            owner.Status.Epoch - 1,
            100,
            25,
            _ =>
            {
                resizeCalls++;
                return Task.FromResult(true);
            }, Xunit.TestContext.Current.CancellationToken);
        var follower = await fixture.Service.ResizeAsync(
            "session-1",
            "browser-b:tab-2",
            owner.Status.Epoch,
            80,
            20,
            _ =>
            {
                resizeCalls++;
                return Task.FromResult(true);
            }, Xunit.TestContext.Current.CancellationToken);

        Assert.True(accepted.ResizeApplied);
        Assert.False(stale.ResizeApplied);
        Assert.False(follower.ResizeApplied);
        Assert.Equal(1, resizeCalls);
    }

    [Theory]
    [InlineData(9, 30)]
    [InlineData(301, 30)]
    [InlineData(120, 4)]
    [InlineData(120, 101)]
    public async Task Resize_RejectsOutOfRangeDimensions(int cols, int rows)
    {
        using var fixture = new Fixture();
        var owner = await fixture.Service.RequestControlAsync("session-1", "browser-a:tab-1", true, ct: Xunit.TestContext.Current.CancellationToken);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => fixture.Service.ResizeAsync(
            "session-1",
            "browser-a:tab-1",
            owner.Status.Epoch,
            cols,
            rows,
            _ => Task.FromResult(true), Xunit.TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task TypingDoesNotWaitForResizeAcknowledgement()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("desktop:tab", new object());
        var owner = await fixture.Service.RequestControlAsync("session-1", "desktop:tab", true, ct: Xunit.TestContext.Current.CancellationToken);
        var acknowledge = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
#pragma warning disable IDISP013 // Intentionally held pending, then awaited in finally before fixture disposal.
        var resizing = fixture.Service.ResizeAsync("session-1", "desktop:tab", owner.Status.Epoch,
            100, 30, _ => acknowledge.Task, Xunit.TestContext.Current.CancellationToken);
#pragma warning restore IDISP013
        try
        {
            Assert.False(resizing.IsCompleted);
            var ownerInput = fixture.Service.RecordInputAsync("session-1", "desktop:tab", ct: Xunit.TestContext.Current.CancellationToken);
            Assert.True(ownerInput.IsCompletedSuccessfully);
            Assert.True(ownerInput.Result.Status.IsOwner);
            var followerInput = fixture.Service.RecordInputAsync("session-1", "ipad:tab", ct: Xunit.TestContext.Current.CancellationToken);
            Assert.True(followerInput.IsCompletedSuccessfully);
            Assert.False(followerInput.Result.Status.IsOwner);
        }
        finally
        {
            acknowledge.SetResult(true);
            await resizing;
        }
    }

    [Fact]
    public async Task PassiveReplacementTabInheritsOnlyItsOwnOfflineProfile()
    {
        using var fixture = new Fixture();
        var connection = new object();
        fixture.Service.RegisterBrowser("desktop:old", connection);
        await fixture.Service.RequestControlAsync("session-1", "desktop:old", true, ct: Xunit.TestContext.Current.CancellationToken);
        Assert.False((await fixture.Service.RequestControlAsync("session-1", "desktop:new", false, ct: Xunit.TestContext.Current.CancellationToken)).Status.IsOwner);
        fixture.Service.UnregisterBrowser("desktop:old", connection);
        Assert.False((await fixture.Service.RequestControlAsync("session-1", "ipad:new", false, ct: Xunit.TestContext.Current.CancellationToken)).Status.IsOwner);
        Assert.True((await fixture.Service.RequestControlAsync("session-1", "desktop:new", false, ct: Xunit.TestContext.Current.CancellationToken)).Status.IsOwner);
    }

    [Fact]
    public async Task PassiveIpadNeverTakesDesktopAfterExpiryOrReconnect()
    {
        using var fixture = new Fixture();
        var desktop = new object();
        fixture.Service.RegisterBrowser("desktop:tab", desktop);
        fixture.Service.RegisterBrowser("ipad:tab", new object());
        var owner = await fixture.Service.RequestControlAsync("session-1", "desktop:tab", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromHours(1));
        var online = await fixture.Service.RequestControlAsync("session-1", "ipad:tab", false, ct: Xunit.TestContext.Current.CancellationToken);
        Assert.False(online.Status.IsOwner);
        fixture.Service.UnregisterBrowser("desktop:tab", desktop);
        fixture.Time.Advance(TimeSpan.FromHours(1));
        var offline = await fixture.Service.RequestControlAsync("session-1", "ipad:tab", false, ct: Xunit.TestContext.Current.CancellationToken);
        Assert.False(offline.Status.IsOwner);
        fixture.Service.RegisterBrowser("desktop:tab", desktop);
        Assert.True(fixture.Service.GetStatus("session-1", "desktop:tab").IsOwner);
        Assert.Equal(owner.Status.Epoch, offline.Status.Epoch);
        var input = await fixture.Service.RecordInputAsync("session-1", "ipad:tab", ct: Xunit.TestContext.Current.CancellationToken);
        Assert.True(input.Status.IsOwner);
    }

    [Fact]
    public async Task PassiveOwnerRequestDoesNotRenewProtection()
    {
        using var fixture = new Fixture();
        fixture.Service.RegisterBrowser("desktop:tab", new object());
        await fixture.Service.RequestControlAsync("session-1", "desktop:tab", true, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromMinutes(4));
        await fixture.Service.RequestControlAsync("session-1", "desktop:tab", false, ct: Xunit.TestContext.Current.CancellationToken);
        fixture.Time.Advance(TimeSpan.FromMinutes(1));
        Assert.True((await fixture.Service.RecordInputAsync("session-1", "ipad:tab", ct: Xunit.TestContext.Current.CancellationToken)).Status.IsOwner);
    }

    [Fact]
    public async Task HeadlessResizeCannotChangeBrowserOwnedSize()
    {
        using var fixture = new Fixture();
        var calls = 0;
        Task<bool> Resize(CancellationToken _) { calls++; return Task.FromResult(true); }
        Assert.True(await fixture.Service.ResizeUnownedAsync("session-1", 100, 30, Resize, Xunit.TestContext.Current.CancellationToken));
        await fixture.Service.RequestControlAsync("session-1", "desktop:tab", true, ct: Xunit.TestContext.Current.CancellationToken);
        Assert.False(await fixture.Service.ResizeUnownedAsync("session-1", 80, 24, Resize, Xunit.TestContext.Current.CancellationToken));
        Assert.Equal(1, calls);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly string _directory = Path.Combine(Path.GetTempPath(), $"midterm-size-control-{Guid.NewGuid():N}");

        public Fixture()
        {
            Directory.CreateDirectory(_directory);
            Time = new ManualTimeProvider(new DateTimeOffset(2026, 7, 20, 12, 0, 0, TimeSpan.Zero));
            Service = new TerminalSizeControlService(_directory, Time);
        }

        public ManualTimeProvider Time { get; }
        public TerminalSizeControlService Service { get; private set; }

        public void RestartService()
        {
            Service.Dispose();
            Service = new TerminalSizeControlService(_directory, Time);
        }

        public void Dispose()
        {
            Service.Dispose();
            Directory.Delete(_directory, recursive: true);
        }
    }

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan elapsed)
        {
            _utcNow += elapsed;
        }
    }
}
