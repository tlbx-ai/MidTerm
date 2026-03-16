using Ai.Tlbx.MidTerm.Models.Security;
using Ai.Tlbx.MidTerm.Services.Security;

namespace Ai.Tlbx.MidTerm.Services.Security;

public static class SecurityEndpoints
{
    public static void MapSecurityEndpoints(
        WebApplication app,
        SecurityStatusService securityStatusService,
        ApiKeyService apiKeyService)
    {
        app.MapGet("/api/security/status", () =>
        {
            return Results.Json(securityStatusService.GetStatus(), AppJsonContext.Default.SecurityStatus);
        });

        app.MapGet("/api/security/api-keys", () =>
        {
            try
            {
                return Results.Json(apiKeyService.ListApiKeys(), AppJsonContext.Default.ApiKeyListResponse);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status500InternalServerError);
            }
        });

        app.MapPost("/api/security/api-keys", (CreateApiKeyRequest request) =>
        {
            try
            {
                return Results.Json(
                    apiKeyService.CreateApiKey(request.Name),
                    AppJsonContext.Default.CreateApiKeyResponse,
                    statusCode: StatusCodes.Status201Created);
            }
            catch (ArgumentException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status400BadRequest);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status500InternalServerError);
            }
        });

        app.MapDelete("/api/security/api-keys/{id}", (string id) =>
        {
            try
            {
                return apiKeyService.DeleteApiKey(id)
                    ? Results.NoContent()
                    : Results.NotFound();
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status500InternalServerError);
            }
        });

        app.MapGet("/api/security/firewall", (WindowsFirewallService firewallService) =>
        {
            return Results.Json(firewallService.GetStatus(), AppJsonContext.Default.FirewallRuleStatusResponse);
        });

        app.MapPost("/api/security/firewall", (WindowsFirewallService firewallService) =>
        {
            try
            {
                return Results.Json(firewallService.EnsureRule(), AppJsonContext.Default.FirewallRuleStatusResponse);
            }
            catch (UnauthorizedAccessException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status403Forbidden);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status400BadRequest);
            }
        });

        app.MapDelete("/api/security/firewall", (WindowsFirewallService firewallService) =>
        {
            try
            {
                return Results.Json(firewallService.RemoveRule(), AppJsonContext.Default.FirewallRuleStatusResponse);
            }
            catch (UnauthorizedAccessException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status403Forbidden);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status400BadRequest);
            }
        });
    }
}
