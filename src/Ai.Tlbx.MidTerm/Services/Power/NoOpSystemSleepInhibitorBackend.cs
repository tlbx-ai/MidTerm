namespace Ai.Tlbx.MidTerm.Services.Power;

internal sealed class NoOpSystemSleepInhibitorBackend : ISystemSleepInhibitorBackend
{
    public bool Activate()
    {
        return false;
    }

    public void Deactivate()
    {
    }

    public void Dispose()
    {
    }
}
