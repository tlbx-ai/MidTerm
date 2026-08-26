using Ai.Tlbx.MidTerm.Services;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public static class AgentControllerInstallationEndpoints
{
    public static void MapAgentControllerInstallationEndpoints(
        WebApplication app,
        AgentControllerInstallationService installations)
    {
        app.MapGet("/api/agent-controller/installations", () =>
            Results.Json(
                installations.GetInstalled(),
                AppJsonContext.Default.ListAgentControllerInstallationDto));
    }
}
