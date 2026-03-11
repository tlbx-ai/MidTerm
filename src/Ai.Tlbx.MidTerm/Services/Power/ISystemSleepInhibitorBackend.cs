namespace Ai.Tlbx.MidTerm.Services.Power;

internal interface ISystemSleepInhibitorBackend : IDisposable
{
    bool Activate();
    void Deactivate();
}
