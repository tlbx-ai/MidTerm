using Ai.Tlbx.MidTerm.Services;
using Ai.Tlbx.MidTerm.Models.Sessions;

namespace Ai.Tlbx.MidTerm.Services.Sessions;

public static class SessionLayoutEndpoints
{
    public static void MapSessionLayoutEndpoints(
        WebApplication app,
        TtyHostSessionManager sessionManager,
        SessionLayoutStateService layoutStateService)
    {
        app.MapGet("/api/layout", () =>
        {
            var snapshot = layoutStateService.GetSnapshot(sessionManager.GetAllSessions().Select(s => s.Id));
            return Results.Json(snapshot, AppJsonContext.Default.SessionLayoutState);
        });

        app.MapPut("/api/layout", (SessionLayoutState request) =>
        {
            var snapshot = layoutStateService.UpdateLayout(
                request.Root,
                request.FocusedSessionId,
                sessionManager.GetAllSessions().Select(s => s.Id));
            return Results.Json(snapshot, AppJsonContext.Default.SessionLayoutState);
        });
    }
}
