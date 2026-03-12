using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Security;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Ai.Tlbx.MidTerm.Api.Endpoints;

public static class SecurityEndpointDefinitions
{
    public static IEndpointRouteBuilder MapSecurityApiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/security/status", (ISecurityHandler handler) =>
            handler.GetSecurityStatus())
            .Produces<SecurityStatus>(StatusCodes.Status200OK, "application/json");

        app.MapGet("/api/security/api-keys", (ISecurityHandler handler) =>
            handler.GetApiKeys())
            .Produces<ApiKeyListResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/security/api-keys", (CreateApiKeyRequest request, ISecurityHandler handler) =>
            handler.CreateApiKey(request))
            .Produces<CreateApiKeyResponse>(StatusCodes.Status201Created, "application/json");

        app.MapDelete("/api/security/api-keys/{id}", (string id, ISecurityHandler handler) =>
            handler.DeleteApiKey(id))
            .Produces(StatusCodes.Status204NoContent);

        app.MapGet("/api/security/firewall", (ISecurityHandler handler) =>
            handler.GetFirewallStatus())
            .Produces<FirewallRuleStatusResponse>(StatusCodes.Status200OK, "application/json");

        app.MapPost("/api/security/firewall", (ISecurityHandler handler) =>
            handler.AddFirewallRule())
            .Produces<FirewallRuleStatusResponse>(StatusCodes.Status200OK, "application/json");

        app.MapDelete("/api/security/firewall", (ISecurityHandler handler) =>
            handler.RemoveFirewallRule())
            .Produces<FirewallRuleStatusResponse>(StatusCodes.Status200OK, "application/json");

        return app;
    }
}
