using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

[JsonSerializable(typeof(GitStatusResponse))]
[JsonSerializable(typeof(GitFileEntry))]
[JsonSerializable(typeof(GitFileEntry[]))]
[JsonSerializable(typeof(GitLogEntry))]
[JsonSerializable(typeof(GitLogEntry[]))]
[JsonSerializable(typeof(GitWsMessage))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
public partial class GitJsonContext : JsonSerializerContext
{
}
