namespace Ai.Tlbx.MidTerm.Models.Auth;

/// <summary>
/// Request payload for changing the authentication password.
/// </summary>
public sealed class ChangePasswordRequest
{
    public string? CurrentPassword { get; init; }
    public string NewPassword { get; init; } = "";
}
