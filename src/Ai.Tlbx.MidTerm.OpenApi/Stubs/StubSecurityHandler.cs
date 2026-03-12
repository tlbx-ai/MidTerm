using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Security;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public sealed class StubSecurityHandler : ISecurityHandler
{
    public IResult GetSecurityStatus() =>
        Results.Json(new SecurityStatus { PasswordProtected = true, CertificateTrusted = true });

    public IResult GetApiKeys() =>
        Results.Json(new ApiKeyListResponse
        {
            ApiKeys =
            [
                new ApiKeyInfoResponse
                {
                    Id = "a1b2c3d4e5f6",
                    Name = "Primary Agent",
                    Preview = "mtk_a1b2c3d4e5f6_12ab...89ef",
                    CreatedAtUtc = DateTimeOffset.Parse("2026-03-12T20:00:00Z"),
                    LastUsedAtUtc = DateTimeOffset.Parse("2026-03-12T21:15:00Z")
                }
            ]
        });

    public IResult CreateApiKey(CreateApiKeyRequest request) =>
        Results.Json(new CreateApiKeyResponse
        {
            ApiKey = new ApiKeyInfoResponse
            {
                Id = "f6e5d4c3b2a1",
                Name = string.IsNullOrWhiteSpace(request.Name) ? "New Agent" : request.Name,
                Preview = "mtk_f6e5d4c3b2a1_ab12...ef90",
                CreatedAtUtc = DateTimeOffset.Parse("2026-03-12T22:00:00Z"),
                LastUsedAtUtc = null
            },
            Token = "mtk_f6e5d4c3b2a1_ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90cd12ef34"
        }, statusCode: StatusCodes.Status201Created);

    public IResult DeleteApiKey(string id) =>
        string.IsNullOrWhiteSpace(id) ? Results.NotFound() : Results.NoContent();

    public IResult GetFirewallStatus() =>
        Results.Json(new FirewallRuleStatusResponse
        {
            Supported = true,
            CanManage = true,
            RulePresent = true,
            RuleEnabled = true,
            MatchesCurrentPort = true,
            MatchesCurrentProgram = true,
            Port = 2000,
            BindAddress = "0.0.0.0",
            RuleName = "MidTerm HTTPS"
        });

    public IResult AddFirewallRule() =>
        GetFirewallStatus();

    public IResult RemoveFirewallRule() =>
        Results.Json(new FirewallRuleStatusResponse
        {
            Supported = true,
            CanManage = true,
            RulePresent = false,
            RuleEnabled = false,
            MatchesCurrentPort = false,
            MatchesCurrentProgram = false,
            Port = 2000,
            BindAddress = "0.0.0.0",
            RuleName = "MidTerm HTTPS"
        });
}
