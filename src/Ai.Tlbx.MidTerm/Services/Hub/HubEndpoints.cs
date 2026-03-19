using Ai.Tlbx.MidTerm.Models.Hub;
using Ai.Tlbx.MidTerm.Models.Sessions;
using Ai.Tlbx.MidTerm.Services.Hub;

namespace Ai.Tlbx.MidTerm.Services.Hub;

public static class HubEndpoints
{
    public static void MapHubEndpoints(WebApplication app, HubService hubService)
    {
        app.MapGet("/api/hub/state", async (CancellationToken ct) =>
        {
            var state = await hubService.GetStateAsync(ct);
            return Results.Json(state, AppJsonContext.Default.HubStateResponse);
        });

        app.MapPost("/api/hub/machines", (HubMachineUpsertRequest request) =>
        {
            var machine = hubService.UpsertMachine(id: null, request);
            return Results.Json(machine, AppJsonContext.Default.HubMachineInfo);
        });

        app.MapPut("/api/hub/machines/{id}", (string id, HubMachineUpsertRequest request) =>
        {
            var machine = hubService.UpsertMachine(id, request);
            return Results.Json(machine, AppJsonContext.Default.HubMachineInfo);
        });

        app.MapDelete("/api/hub/machines/{id}", (string id) =>
        {
            return hubService.DeleteMachine(id) ? Results.Ok() : Results.NotFound();
        });

        app.MapPost("/api/hub/machines/{id}/refresh", async (string id, CancellationToken ct) =>
        {
            var machine = await hubService.GetMachineStateAsync(id, ct);
            return Results.Json(machine, AppJsonContext.Default.HubMachineState);
        });

        app.MapPost("/api/hub/machines/{id}/pin", async (string id, HubMachinePinRequest request, CancellationToken ct) =>
        {
            var fingerprint = request.Fingerprint;
            if (string.IsNullOrWhiteSpace(fingerprint))
            {
                var machine = await hubService.GetMachineStateAsync(id, ct);
                fingerprint = machine.Machine.LastFingerprint;
            }

            if (string.IsNullOrWhiteSpace(fingerprint))
            {
                return Results.BadRequest("No fingerprint available to pin.");
            }

            var pinned = hubService.PinFingerprint(id, fingerprint);
            return Results.Json(new HubMachinePinRequest { Fingerprint = pinned }, AppJsonContext.Default.HubMachinePinRequest);
        });

        app.MapDelete("/api/hub/machines/{id}/pin", (string id) =>
        {
            return hubService.ClearPinnedFingerprint(id) ? Results.Ok() : Results.NotFound();
        });

        app.MapPost("/api/hub/machines/{id}/sessions", async (string id, CreateSessionRequest? request, CancellationToken ct) =>
        {
            var session = await hubService.CreateSessionAsync(id, request, ct);
            return Results.Json(session, AppJsonContext.Default.SessionInfoDto);
        });

        app.MapDelete("/api/hub/machines/{id}/sessions/{sessionId}", async (string id, string sessionId, CancellationToken ct) =>
        {
            await hubService.DeleteSessionAsync(id, sessionId, ct);
            return Results.Ok();
        });

        app.MapPut("/api/hub/machines/{id}/sessions/{sessionId}/name", async (string id, string sessionId, RenameSessionRequest request, CancellationToken ct) =>
        {
            await hubService.RenameSessionAsync(id, sessionId, request, ct);
            return Results.Ok();
        });

        app.MapPost("/api/hub/updates/apply", async (HubUpdateRolloutRequest request, CancellationToken ct) =>
        {
            var response = await hubService.ApplyUpdatesAsync(request, ct);
            return Results.Json(response, AppJsonContext.Default.HubUpdateRolloutResponse);
        });
    }
}
