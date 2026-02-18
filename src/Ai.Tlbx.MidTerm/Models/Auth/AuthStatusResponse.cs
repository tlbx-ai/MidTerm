namespace Ai.Tlbx.MidTerm.Models.Auth;

/// <summary>
/// Response payload describing the current authentication status.
/// </summary>
public sealed class AuthStatusResponse
{
    public bool AuthenticationEnabled { get; init; }
    public bool PasswordSet { get; init; }
}
