using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.Api.Handlers;

public interface IAuthHandler
{
    IResult Login(LoginRequest request, HttpContext ctx);
    IResult Logout(HttpContext ctx);
    IResult ChangePassword(ChangePasswordRequest request, HttpContext ctx);
    IResult GetStatus();
    IResult GetSecurityStatus();
}
