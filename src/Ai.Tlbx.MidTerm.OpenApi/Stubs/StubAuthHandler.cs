using Ai.Tlbx.MidTerm.Api.Handlers;
using Ai.Tlbx.MidTerm.Models;
using Ai.Tlbx.MidTerm.Models.Update;
using Ai.Tlbx.MidTerm.Settings;
using Microsoft.AspNetCore.Http;

namespace Ai.Tlbx.MidTerm.OpenApi.Stubs;

public class StubAuthHandler : IAuthHandler
{
    public IResult Login(LoginRequest request, HttpContext ctx) =>
        Results.Json(new AuthResponse { Success = true });

    public IResult Logout(HttpContext ctx) =>
        Results.Ok();

    public IResult ChangePassword(ChangePasswordRequest request, HttpContext ctx) =>
        Results.Json(new AuthResponse { Success = true });

    public IResult GetStatus() =>
        Results.Json(new AuthStatusResponse { AuthenticationEnabled = true, PasswordSet = true });

    public IResult GetSecurityStatus() =>
        Results.Json(new SecurityStatus { PasswordProtected = true, CertificateTrusted = true });
}
