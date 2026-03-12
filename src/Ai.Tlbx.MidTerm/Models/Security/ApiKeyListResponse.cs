namespace Ai.Tlbx.MidTerm.Models.Security;

public sealed class ApiKeyListResponse
{
    public List<ApiKeyInfoResponse> ApiKeys { get; init; } = [];
}
