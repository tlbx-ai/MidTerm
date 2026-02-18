using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Models.Update;

namespace Ai.Tlbx.MidTerm.Services.Updates;

[JsonSerializable(typeof(VersionManifest))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class VersionManifestContext : JsonSerializerContext
{
}
