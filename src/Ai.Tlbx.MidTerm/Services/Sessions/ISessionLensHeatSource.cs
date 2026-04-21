namespace Ai.Tlbx.MidTerm.Services.Sessions;

public interface ISessionLensHeatSource
{
    SessionLensHeatSnapshot GetHeatSnapshot(string sessionId);
}
