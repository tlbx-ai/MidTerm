using Ai.Tlbx.MidTerm.Models.Auth;
using Ai.Tlbx.MidTerm.Models.Security;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface ISecurityHandler
{
    IResult GetSecurityStatus();
    IResult GetApiKeys();
    IResult CreateApiKey(CreateApiKeyRequest request);
    IResult DeleteApiKey(string id);
    IResult GetFirewallStatus();
    IResult AddFirewallRule();
    IResult RemoveFirewallRule();
}
