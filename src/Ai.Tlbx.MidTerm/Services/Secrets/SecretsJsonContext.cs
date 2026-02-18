using System.Text.Json.Serialization;

namespace Ai.Tlbx.MidTerm.Services.Secrets;

[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSourceGenerationOptions(WriteIndented = true)]
internal partial class SecretsJsonContext : JsonSerializerContext
{
}
