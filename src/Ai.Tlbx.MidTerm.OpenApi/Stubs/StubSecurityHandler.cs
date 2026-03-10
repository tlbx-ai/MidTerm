using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Security;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public sealed class StubSecurityHandler : ISecurityHandler
{
    public IResult GetSecurityStatus() =>
        Results.Json(new SecurityStatus { PasswordProtected = true, CertificateTrusted = true });

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
