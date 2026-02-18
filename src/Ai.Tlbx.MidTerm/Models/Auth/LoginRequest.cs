namespace Ai.Tlbx.MidTerm.Models.Auth;

/// <summary>
/// Request payload for user authentication.
/// </summary>
public sealed class LoginRequest
{
    public string Password { get; init; } = "";
}
