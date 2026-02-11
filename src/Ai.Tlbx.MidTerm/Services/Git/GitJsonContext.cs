using System.Text.Json.Serialization;
using Ai.Tlbx.MidTerm.Models.Git;

namespace Ai.Tlbx.MidTerm.Services.Git;

[JsonSerializable(typeof(GitStatusResponse))]
[JsonSerializable(typeof(GitFileEntry))]
[JsonSerializable(typeof(GitFileEntry[]))]
[JsonSerializable(typeof(GitLogEntry))]
[JsonSerializable(typeof(GitLogEntry[]))]
[JsonSerializable(typeof(GitWsMessage))]
[JsonSerializable(typeof(GitStageRequest))]
[JsonSerializable(typeof(GitUnstageRequest))]
[JsonSerializable(typeof(GitCommitRequest))]
[JsonSerializable(typeof(GitPushPullRequest))]
[JsonSerializable(typeof(GitStashRequest))]
[JsonSerializable(typeof(GitDiscardRequest))]
[JsonSerializable(typeof(GitDiffRequest))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
public partial class GitJsonContext : JsonSerializerContext
{
}
