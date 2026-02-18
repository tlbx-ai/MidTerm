namespace Ai.Tlbx.MidTerm.Models.Auth;

/// <summary>
/// Response payload for authentication operations.
/// </summary>
public sealed class AuthResponse
{
    public bool Success { get; init; }
    public string? Error { get; init; }
}
