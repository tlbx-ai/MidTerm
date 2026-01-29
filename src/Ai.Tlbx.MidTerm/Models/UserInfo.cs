namespace Ai.Tlbx.MidTerm.Models;

public sealed class UserInfo
{
    public required string Username { get; init; }
    public string? Sid { get; init; }      // Windows only
    public int? Uid { get; init; }          // Unix only
    public int? Gid { get; init; }          // Unix only
}
