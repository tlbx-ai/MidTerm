namespace Ai.Tlbx.MidTerm.Services.Sessions;

public interface ISessionAppServerControlHeatSource
{
    SessionAppServerControlHeatSnapshot GetHeatSnapshot(string sessionId);
}
