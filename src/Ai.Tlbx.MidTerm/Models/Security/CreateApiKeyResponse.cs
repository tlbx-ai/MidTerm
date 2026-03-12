namespace Ai.Tlbx.MidTerm.Models.Security;

public sealed class CreateApiKeyResponse
{
    public ApiKeyInfoResponse ApiKey { get; init; } = new();
    public string Token { get; init; } = "";
}
