using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Services.Share;

[JsonSerializable(typeof(ShareGrantStoreFile))]
[JsonSerializable(typeof(List<ShareGrantRecord>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class ShareJsonContext : JsonSerializerContext
{
}
