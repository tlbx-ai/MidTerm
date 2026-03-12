namespace Ai.Tlbx.MidTerm.Models.Security;

public sealed class ApiKeyInfoResponse
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Preview { get; init; } = "";
    public DateTimeOffset CreatedAtUtc { get; init; }
    public DateTimeOffset? LastUsedAtUtc { get; init; }
}
