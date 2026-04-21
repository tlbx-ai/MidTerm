using Ai.Tlbx.MidTerm.Settings;
using Ai.Tlbx.MidTerm.Services.Power;
using Xunit;

namespace Ai.Tlbx.MidTerm.UnitTests;

public sealed class SystemSleepInhibitorServiceTests
{
    [Fact]
    public void UpdateSessionCount_ActivatesOnlyWhenEnabledAndSessionsExist()
    {
        using var backend = new FakeSystemSleepInhibitorBackend();
        using var service = new SystemSleepInhibitorService(backend);

        service.UpdateSessionCount(1);
        Assert.Equal(0, backend.ActivateCalls);

        service.UpdateEnabled(true);
        Assert.Equal(1, backend.ActivateCalls);

        service.UpdateSessionCount(3);
        Assert.Equal(1, backend.ActivateCalls);

        service.UpdateSessionCount(0);
        Assert.Equal(1, backend.DeactivateCalls);
    }

    [Fact]
    public void UpdateEnabled_False_DisablesActiveInhibitor()
    {
        using var backend = new FakeSystemSleepInhibitorBackend();
        using var service = new SystemSleepInhibitorService(backend);

        service.UpdateEnabled(true);
        service.UpdateSessionCount(2);
        Assert.Equal(1, backend.ActivateCalls);

        service.UpdateEnabled(false);
        Assert.Equal(1, backend.DeactivateCalls);
    }

    [Fact]
    public void Dispose_DeactivatesBackendOnce()
    {
        using var backend = new FakeSystemSleepInhibitorBackend();
        SystemSleepInhibitorService? service = new(backend);

        try
        {
            service.UpdateEnabled(true);
            service.UpdateSessionCount(1);
            var ownedService = service;
            service = null;
            ownedService.Dispose();
        }
        finally
        {
            service?.Dispose();
        }

        Assert.Equal(1, backend.ActivateCalls);
        Assert.Equal(1, backend.DeactivateCalls);
        Assert.Equal(1, backend.DisposeCalls);
    }

    [Fact]
    public void MidTermSettingsPublic_RoundTripsKeepAwakeSetting()
    {
        var settings = new MidTermSettings
        {
            KeepSystemAwakeWithActiveSessions = true
        };

        var publicSettings = MidTermSettingsPublic.FromSettings(settings);
        Assert.True(publicSettings.KeepSystemAwakeWithActiveSessions);

        settings.KeepSystemAwakeWithActiveSessions = false;
        publicSettings.ApplyTo(settings);

        Assert.True(settings.KeepSystemAwakeWithActiveSessions);
    }

    private sealed class FakeSystemSleepInhibitorBackend : ISystemSleepInhibitorBackend
    {
        public int ActivateCalls { get; private set; }
        public int DeactivateCalls { get; private set; }
        public int DisposeCalls { get; private set; }
        private bool _disposed;

        public bool Activate()
        {
            ActivateCalls++;
            return true;
        }

        public void Deactivate()
        {
            DeactivateCalls++;
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            DisposeCalls++;
        }
    }

}
