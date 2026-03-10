using Ai.Tlbx.MidTerm.Services.Security;

namespace Ai.Tlbx.MidTerm.Services.Security;

public static class SecurityEndpoints
{
    public static void MapSecurityEndpoints(WebApplication app, SecurityStatusService securityStatusService)
    {
        app.MapGet("/api/security/status", () =>
        {
            return Results.Json(securityStatusService.GetStatus(), AppJsonContext.Default.SecurityStatus);
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
