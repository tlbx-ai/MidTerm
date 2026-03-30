using Ai.Tlbx.MidTerm.Models.Share;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IShareHandler
{
    IResult CreateShareLink(CreateShareLinkRequest request);
    IResult GetActiveShares(int? limit);
    IResult RevokeShare(string grantId);
    IResult ClaimShareLink(ClaimShareRequest request);
    IResult GetShareBootstrap();
}
